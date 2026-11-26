//! The feed pipeline.
//!
//! 1. `ycbcr.frag` converts the decoder's planes to RGB **at the source raster**.
//! 2. `peaking_blur.frag` and `peaking_mask.frag` build the edge mask, when peaking is on.
//! 3. `feed.frag` grades through the display transform and the colour cube, and paints
//!    monochrome, false colour, peaking and zebra.
//! 4. `blit.frag` stretches the result to the display raster (desqueezed, fitted).
//! 5. `overlay.frag` composites the shell's chrome over it, into the image or the
//!    swapchain. The chrome never goes through the cube, so a HUD reads true.
//!
//! The order is the phones' order and is not an accident: cubing after the upsample
//! blotched D-Log2 on Android, and it would here too.
//!
//! Three sets of render targets, so no path rebuilds another's:
//!
//! - the **live** targets, at the swapchain's raster, for [`FeedRenderer::present`];
//! - the **still** targets, for [`FeedRenderer::render`] and
//!   [`FeedRenderer::render_picture`], rendered synchronously;
//! - the **async** targets, for [`FeedRenderer::render_async`] (the virtual camera): a
//!   fence-guarded submission whose readback is collected on a later call, so a 1280×720
//!   output never waits on the device or thrashes the window's targets (D4/P21).

use std::io::Cursor;

use ash::{vk, Device};
use opc_decode::Picture;
use raw_window_handle::{RawDisplayHandle, RawWindowHandle};

use crate::color::DisplayTransform;
use crate::device::Gpu;
use crate::error::{Context, RenderError};
use crate::lut::Lut;
use crate::present::{Presented, Presenter, Surface, SurfaceSource};
use crate::resources::{transition, DeviceImage, HostBuffer};

pub use crate::options::{
    Desqueeze, FalseColorScale, GradeOptions, Look, Peaking, PeakingSense, PictureFit, Zebra,
};

const COLOR_FORMAT: vk::Format = vk::Format::R8G8B8A8_UNORM;
const PLANE_FORMAT: vk::Format = vk::Format::R8_UNORM;
const LUT_FORMAT: vk::Format = vk::Format::R32G32B32A32_SFLOAT;
/// `feed.frag`'s push-constant block: 32 floats, the 128 bytes every device guarantees.
const FEED_CONSTANTS: usize = 32;
/// `feed.frag`'s `LookBlock` uniform: six `vec4`s.
const LOOK_FLOATS: usize = 24;
/// The feed pass's uniform buffer binding, after its five samplers.
const LOOK_BINDING: u32 = 5;
const MAX_RASTER: u32 = 8192;
/// The widest viewport a cover fit may ask for; every device allows at least 4096 and
/// desktop GPUs 16384 or more. A wider one is clamped (a little less crop, never an error).
const MAX_VIEWPORT: u32 = 16384;

const PASS_YCBCR: usize = 0;
const PASS_FEED: usize = 1;
const PASS_BLIT: usize = 2;
const PASS_PEAK_BLUR: usize = 3;
const PASS_PEAK_MASK: usize = 4;
/// Composites the shell's chrome over the stretched picture. Separate from the grade so
/// the HUD never goes through the colour cube.
const PASS_OVERLAY: usize = 5;
const PASS_COUNT: usize = 6;
/// Sampler bindings per pass, indexed by `PASS_*`. The feed pass also has its uniform.
const SAMPLER_COUNTS: [u32; PASS_COUNT] = [3, 5, 1, 1, 2, 2];

/// Where a picture of `source` shape sits inside a `display` of another, keeping its
/// proportions and centring the remainder: `(x, y, width, height)` in display pixels.
///
/// The blit draws into exactly this rectangle, so the bars around it are the render
/// pass's own clear. A shell mapping a click back to the picture must use the same
/// rectangle or it will point the camera somewhere near what the operator meant.
pub fn letterbox(source: (u32, u32), display: (u32, u32)) -> (u32, u32, u32, u32) {
    if source.0 == 0 || source.1 == 0 || display.0 == 0 || display.1 == 0 {
        return (0, 0, display.0, display.1);
    }
    let scale = (f64::from(display.0) / f64::from(source.0))
        .min(f64::from(display.1) / f64::from(source.1));
    let width = ((f64::from(source.0) * scale).round() as u32).clamp(1, display.0);
    let height = ((f64::from(source.1) * scale).round() as u32).clamp(1, display.1);
    (
        (display.0 - width) / 2,
        (display.1 - height) / 2,
        width,
        height,
    )
}

/// [`letterbox`] inside a sub-rectangle `(x, y, width, height)` of the display, for a
/// picture drawn into part of a window (the web view's transparent hole). The result is
/// in the same display pixels as `rect`.
pub fn letterbox_in(source: (u32, u32), rect: (u32, u32, u32, u32)) -> (u32, u32, u32, u32) {
    let (x, y, width, height) = letterbox(source, (rect.2, rect.3));
    (rect.0 + x, rect.1 + y, width, height)
}

/// Where a picture of `source` shape is drawn for `rect` under `fit`: [`letterbox_in`] for
/// `Contain`; for `Cover`, the smallest centred rectangle of the picture's shape that
/// covers `rect` (it can start left of or above `rect`, which then crops it). This is the
/// one formula both the blit and a shell mapping clicks or overlays must use.
pub fn fit_in(
    source: (u32, u32),
    rect: (u32, u32, u32, u32),
    fit: PictureFit,
) -> (i32, i32, u32, u32) {
    if fit == PictureFit::Contain || source.0 == 0 || source.1 == 0 || rect.2 == 0 || rect.3 == 0 {
        let (x, y, width, height) = letterbox_in(source, rect);
        return (x as i32, y as i32, width, height);
    }
    let scale =
        (f64::from(rect.2) / f64::from(source.0)).max(f64::from(rect.3) / f64::from(source.1));
    let width =
        ((f64::from(source.0) * scale).round() as u32).clamp(rect.2, MAX_VIEWPORT.max(rect.2));
    let height =
        ((f64::from(source.1) * scale).round() as u32).clamp(rect.3, MAX_VIEWPORT.max(rect.3));
    let x = i64::from(rect.0) - (i64::from(width) - i64::from(rect.2)) / 2;
    let y = i64::from(rect.1) - (i64::from(height) - i64::from(rect.3)) / 2;
    (x as i32, y as i32, width, height)
}

/// A rendered picture, 8-bit RGBA, tightly packed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Rgba {
    /// The pixel at `(x, y)` as `(r, g, b, a)`.
    pub fn pixel(&self, x: u32, y: u32) -> Option<(u8, u8, u8, u8)> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let at = ((y * self.width + x) * 4) as usize;
        Some((
            self.pixels[at],
            self.pixels[at + 1],
            self.pixels[at + 2],
            self.pixels[at + 3],
        ))
    }
}

/// One set of render targets with its own descriptor sets and staging, so the live
/// window, stills and the virtual camera never rebuild or overwrite each other's.
struct Targets {
    source_width: u32,
    source_height: u32,
    display_width: u32,
    display_height: u32,
    planes: [DeviceImage; 3],
    plane_staging: [HostBuffer; 3],
    rgb: DeviceImage,
    graded: DeviceImage,
    output: DeviceImage,
    peaking_blur: DeviceImage,
    peaking_mask: DeviceImage,
    /// The graded picture at the display raster, before chrome.
    stretched: DeviceImage,
    /// The chrome, uploaded from the shell when it changes.
    overlay: DeviceImage,
    overlay_staging: HostBuffer,
    /// Indexed by the `PASS_*` constants; `PASS_BLIT`'s is the offscreen target.
    framebuffers: [vk::Framebuffer; PASS_COUNT],
    readback: HostBuffer,
    /// `feed.frag`'s `LookBlock`.
    look: HostBuffer,
    pool: vk::DescriptorPool,
    sets: [vk::DescriptorSet; PASS_COUNT],
    /// Descriptor writes need these sets idle, so they happen only when something they
    /// point at actually changed — not once a frame.
    descriptors_dirty: bool,
    peaking_bound: bool,
    /// Cleared when the chrome changes, so a still HUD is copied to the staging buffer
    /// once rather than every frame.
    overlay_staged: bool,
}

impl Targets {
    fn matches(&self, picture: &Picture<'_>, display: (u32, u32)) -> bool {
        self.source_width == picture.width
            && self.source_height == picture.height
            && self.display_width == display.0
            && self.display_height == display.1
    }

    unsafe fn destroy(&self, device: &Device) {
        unsafe {
            for framebuffer in self.framebuffers {
                device.destroy_framebuffer(framebuffer, None);
            }
            for plane in &self.planes {
                plane.destroy(device);
            }
            for staging in &self.plane_staging {
                staging.destroy(device);
            }
            for image in [
                &self.rgb,
                &self.graded,
                &self.output,
                &self.peaking_blur,
                &self.peaking_mask,
                &self.stretched,
                &self.overlay,
            ] {
                image.destroy(device);
            }
            self.overlay_staging.destroy(device);
            self.readback.destroy(device);
            self.look.destroy(device);
            device.destroy_descriptor_pool(self.pool, None);
        }
    }
}

/// The async targets' own submission: one command buffer and one fence, so collecting a
/// finished frame never waits on the window's work.
struct AsyncTargets {
    targets: Targets,
    command: vk::CommandBuffer,
    fence: vk::Fence,
    in_flight: bool,
}

struct Pipelines {
    render_pass: vk::RenderPass,
    linear: vk::Sampler,
    /// Packed 16-bit blur values and the edge mask must not be interpolated.
    nearest: vk::Sampler,
    set_layouts: [vk::DescriptorSetLayout; PASS_COUNT],
    layouts: [vk::PipelineLayout; PASS_COUNT],
    pipelines: [vk::Pipeline; PASS_COUNT],
    /// Kept alive so a swapchain can build its own final pipeline for its own format.
    vertex_module: vk::ShaderModule,
    overlay_module: vk::ShaderModule,
}

impl Pipelines {
    unsafe fn destroy(&self, device: &Device) {
        unsafe {
            for pipeline in self.pipelines {
                device.destroy_pipeline(pipeline, None);
            }
            for layout in self.layouts {
                device.destroy_pipeline_layout(layout, None);
            }
            for layout in self.set_layouts {
                device.destroy_descriptor_set_layout(layout, None);
            }
            device.destroy_sampler(self.linear, None);
            device.destroy_sampler(self.nearest, None);
            device.destroy_render_pass(self.render_pass, None);
            device.destroy_shader_module(self.vertex_module, None);
            device.destroy_shader_module(self.overlay_module, None);
        }
    }
}

/// What the descriptor sets point at besides a target's own images.
#[derive(Clone, Copy)]
struct Bound {
    lut: vk::ImageView,
    paint: vk::ImageView,
    weight: vk::ImageView,
    dummy_2d: vk::ImageView,
}

/// Draws decoded pictures, offscreen or into a window.
pub struct FeedRenderer {
    gpu: Gpu,
    pipelines: Pipelines,
    presenter: Option<Presenter>,
    live: Option<Targets>,
    still: Option<Targets>,
    async_out: Option<AsyncTargets>,
    lut: Option<DeviceImage>,
    lut_size: u32,
    /// The false-colour paint and weight lattices, when the shell has asked for them.
    false_color: Option<(DeviceImage, DeviceImage)>,
    false_color_size: u32,
    dummy_2d: DeviceImage,
    dummy_3d: DeviceImage,
    /// The chrome the shell last handed over, at the raster it drew it at.
    overlay: Option<Rgba>,
    overlay_opacity: f32,
    /// Where on the swapchain the picture is letterboxed: the whole surface when `None`
    /// (the winit viewfinder), or the web view's hole in the Tauri app. Moving it is a
    /// viewport change, not a swapchain rebuild.
    picture_rect: Option<(u32, u32, u32, u32)>,
    fit: PictureFit,
    look: Look,
    look_block: [f32; LOOK_FLOATS],
}

impl std::fmt::Debug for FeedRenderer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FeedRenderer")
            .field("device", &self.gpu.device_name)
            .field("lut_size", &self.lut_size)
            .field("presenting", &self.presenter.is_some())
            .finish_non_exhaustive()
    }
}

/// `feed.frag`'s `LookBlock` for one look.
fn look_block(look: &Look) -> [f32; LOOK_FLOATS] {
    let transform = DisplayTransform::new(look.display);
    let m = transform.matrix.map(|value| value as f32);
    let on = if transform.is_identity() { 0.0 } else { 1.0 };
    [
        m[0],
        m[1],
        m[2],
        0.0,
        m[3],
        m[4],
        m[5],
        0.0,
        m[6],
        m[7],
        m[8],
        0.0,
        transform.tone.gain as f32,
        transform.tone.white_reinhard as f32,
        transform.tone.contrast as f32,
        on,
        look.signal.ordinal() as f32,
        look.display.ordinal() as f32,
        if look.exposure_stops.is_finite() {
            look.exposure_stops.clamp(-8.0, 8.0)
        } else {
            0.0
        },
        if look.lut_intensity.is_finite() {
            look.lut_intensity.clamp(0.0, 1.0)
        } else {
            1.0
        },
        f32::from(u8::from(look.monochrome)),
        f32::from(u8::from(look.mirror_vertical)),
        f32::from(u8::from(look.zebra_stripes)),
        0.0,
    ]
}

impl FeedRenderer {
    /// Renders into an image. No surface, no swapchain.
    pub fn new() -> Result<Self, RenderError> {
        Self::build(Gpu::offscreen()?, None, 0, 0)
    }

    /// A real swapchain with no display behind it, for checking the present path.
    pub fn headless_window(width: u32, height: u32) -> Result<Self, RenderError> {
        let instance = [
            ash::khr::surface::NAME.as_ptr(),
            ash::ext::headless_surface::NAME.as_ptr(),
        ];
        let device = [ash::khr::swapchain::NAME.as_ptr()];
        let gpu = Gpu::new(&instance, &device)?;
        Self::build(gpu, Some(SurfaceSource::Headless), width, height)
    }

    /// Draws into a window.
    ///
    /// # Safety
    /// Both handles must stay valid for as long as this renderer lives.
    pub unsafe fn for_window(
        display: RawDisplayHandle,
        window: RawWindowHandle,
        width: u32,
        height: u32,
    ) -> Result<Self, RenderError> {
        let required = ash_window::enumerate_required_extensions(display)
            .context("vkEnumerateInstanceExtensionProperties")?
            .to_vec();
        let device = [ash::khr::swapchain::NAME.as_ptr()];
        let gpu = Gpu::new(&required, &device)?;
        Self::build(
            gpu,
            Some(SurfaceSource::Window { display, window }),
            width,
            height,
        )
    }

    fn build(
        gpu: Gpu,
        source: Option<SurfaceSource>,
        width: u32,
        height: u32,
    ) -> Result<Self, RenderError> {
        let pipelines = build_pipelines(&gpu)?;
        // `feed.frag` samples all five bindings unconditionally, so the ones an operator
        // has turned off still need something bound. A 1x1 texture with the matching
        // `*On` flag at zero keeps the shared shader untouched.
        let dummy_2d = DeviceImage::new_2d(
            &gpu,
            1,
            1,
            COLOR_FORMAT,
            vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST,
        )?;
        let dummy_3d = DeviceImage::new_3d(
            &gpu,
            1,
            LUT_FORMAT,
            vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST,
        )?;
        gpu.one_shot(|command| {
            // Safety: recording, and both images belong to this device.
            unsafe {
                for image in [dummy_2d.image, dummy_3d.image] {
                    transition(
                        &gpu.device,
                        command,
                        image,
                        vk::ImageLayout::UNDEFINED,
                        vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL,
                    );
                }
            }
        })?;

        let presenter = match source {
            Some(source) => {
                let surface = Surface::new(&gpu, &source)?;
                Some(Presenter::new(
                    &gpu,
                    surface,
                    pipelines.layouts[PASS_OVERLAY],
                    pipelines.vertex_module,
                    pipelines.overlay_module,
                    width,
                    height,
                )?)
            }
            None => None,
        };

        let look = Look::default();
        Ok(Self {
            gpu,
            pipelines,
            presenter,
            live: None,
            still: None,
            async_out: None,
            lut: None,
            lut_size: 0,
            false_color: None,
            false_color_size: 0,
            dummy_2d,
            dummy_3d,
            overlay: None,
            overlay_opacity: 1.0,
            picture_rect: None,
            fit: PictureFit::Contain,
            look_block: look_block(&look),
            look,
        })
    }

    /// Which device is drawing. A CPU device means software Vulkan, not a bug.
    pub fn device_name(&self) -> &str {
        &self.gpu.device_name
    }

    /// The swapchain's current size, when there is one.
    pub fn surface_size(&self) -> Option<(u32, u32)> {
        self.presenter
            .as_ref()
            .map(|presenter| (presenter.extent.width, presenter.extent.height))
    }

    /// Letterboxes the presented picture inside `rect` (surface pixels) instead of the
    /// whole surface; the rest is the render pass's black clear. `None` restores the full
    /// surface. Stills and [`render`](Self::render) are unaffected.
    pub fn set_picture_rect(&mut self, rect: Option<(u32, u32, u32, u32)>) {
        self.picture_rect = rect.filter(|rect| rect.2 > 0 && rect.3 > 0);
    }

    /// The rectangle [`set_picture_rect`](Self::set_picture_rect) last set.
    pub fn picture_rect(&self) -> Option<(u32, u32, u32, u32)> {
        self.picture_rect
    }

    /// Whole with bars, or filling the rectangle and cropped ([`fit_in`]). Presents only;
    /// stills and offscreen renders always show the whole picture.
    pub fn set_picture_fit(&mut self, fit: PictureFit) {
        self.fit = fit;
    }

    pub fn picture_fit(&self) -> PictureFit {
        self.fit
    }

    /// The display transform, cube mix, input exposure, mono and vertical-flip views,
    /// solid zebra and desqueeze for every frame from now on. Cheap: a 96-byte uniform
    /// written with the next frame's staging.
    pub fn set_look(&mut self, look: Look) {
        if look != self.look {
            self.look = look;
            self.look_block = look_block(&look);
        }
    }

    pub fn look(&self) -> Look {
        self.look
    }

    /// Tells the swapchain the window changed size. Rebuilt on the next present.
    pub fn resize(&mut self, width: u32, height: u32) {
        if let Some(presenter) = self.presenter.as_mut() {
            presenter.resize(width, height);
        }
    }

    fn each_targets(&mut self, mut touch: impl FnMut(&mut Targets)) {
        if let Some(targets) = self.live.as_mut() {
            touch(targets);
        }
        if let Some(targets) = self.still.as_mut() {
            touch(targets);
        }
        if let Some(out) = self.async_out.as_mut() {
            touch(&mut out.targets);
        }
    }

    /// Uploads the cube the grade uses, or clears it. Passing `None` leaves the picture
    /// ungraded — the shader treats a lattice smaller than 2 as identity.
    pub fn set_lut(&mut self, lut: Option<&Lut>) -> Result<(), RenderError> {
        match lut {
            Some(lut) => {
                let size = lut.size();
                let components = lut.rgba();
                self.set_lut_rgba(size, &components)
            }
            None => {
                self.drop_lut();
                Ok(())
            }
        }
    }

    /// [`set_lut`](Self::set_lut) from a lattice already read out of the core: `size³ × 4`
    /// floats, red fastest, as [`Lut::rgba`] returns them. A shell that parses cubes off
    /// the render thread hands over only this.
    pub fn set_lut_rgba(&mut self, size: u32, rgba: &[f32]) -> Result<(), RenderError> {
        self.drop_lut();
        let (image, size) = self.upload_lattice(size, rgba)?;
        self.lut = Some(image);
        self.lut_size = size;
        Ok(())
    }

    fn drop_lut(&mut self) {
        if let Some(existing) = self.lut.take() {
            // Safety: waiting for idle before destroying what a set may still point at.
            unsafe {
                let _ = self.gpu.device.device_wait_idle();
                existing.destroy(&self.gpu.device);
            }
        }
        self.lut_size = 0;
        self.each_targets(|targets| targets.descriptors_dirty = true);
    }

    /// Uploads the false-colour paint and weight lattices, or drops them. They are
    /// painted only while [`GradeOptions::false_color`] is set, so a scale can stay
    /// loaded while the operator flicks the assist off and on.
    pub fn set_false_color(&mut self, cubes: Option<(&Lut, &Lut)>) -> Result<(), RenderError> {
        if let Some((paint, weight)) = self.false_color.take() {
            // Safety: as in `set_lut`.
            unsafe {
                let _ = self.gpu.device.device_wait_idle();
                paint.destroy(&self.gpu.device);
                weight.destroy(&self.gpu.device);
            }
        }
        self.false_color_size = 0;
        self.each_targets(|targets| targets.descriptors_dirty = true);

        let Some((paint, weight)) = cubes else {
            return Ok(());
        };
        let (paint_image, paint_size) = self.upload_lattice(paint.size(), &paint.rgba())?;
        let (weight_image, weight_size) = match self.upload_lattice(weight.size(), &weight.rgba()) {
            Ok(uploaded) => uploaded,
            Err(error) => {
                // Safety: nothing points at an image no set has seen.
                unsafe { paint_image.destroy(&self.gpu.device) };
                return Err(error);
            }
        };
        if paint_size != weight_size {
            // Safety: as above.
            unsafe {
                paint_image.destroy(&self.gpu.device);
                weight_image.destroy(&self.gpu.device);
            }
            return Err(RenderError::Lut(
                "The false-colour paint and weight lattices differ in size.".to_string(),
            ));
        }
        self.false_color = Some((paint_image, weight_image));
        self.false_color_size = paint_size;
        Ok(())
    }

    /// A lattice as a sampled 3D image, ready for a descriptor.
    fn upload_lattice(
        &self,
        size: u32,
        components: &[f32],
    ) -> Result<(DeviceImage, u32), RenderError> {
        if !(2..=256).contains(&size) || components.len() != (size * size * size * 4) as usize {
            return Err(RenderError::Lut(
                "That cube has no usable lattice.".to_string(),
            ));
        }

        let image = DeviceImage::new_3d(
            &self.gpu,
            size,
            LUT_FORMAT,
            vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST,
        )?;
        let bytes = as_bytes(components);
        let staging = HostBuffer::new(
            &self.gpu,
            bytes.len() as vk::DeviceSize,
            vk::BufferUsageFlags::TRANSFER_SRC,
        )?;
        staging.write_bytes(&self.gpu.device, bytes)?;

        let device = &self.gpu.device;
        let result = self.gpu.one_shot(|command| {
            // Safety: recording; the image and buffer belong to this device.
            unsafe {
                transition(
                    device,
                    command,
                    image.image,
                    vk::ImageLayout::UNDEFINED,
                    vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                );
                copy_buffer_to_image(device, command, staging.buffer, &image, size, size, size);
                transition(
                    device,
                    command,
                    image.image,
                    vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                    vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL,
                );
            }
        });
        // Safety: the submission finished before `one_shot` returned.
        unsafe { staging.destroy(device) };
        if let Err(error) = result {
            // Safety: the image was never bound.
            unsafe { image.destroy(device) };
            return Err(error);
        }
        Ok((image, size))
    }

    /// Hands the shell's chrome over, to be composited after the stretch.
    ///
    /// The chrome is expected at the display raster. A mismatch is cropped or padded
    /// rather than refused: a window that resized between the shell drawing and this
    /// call should cost one slightly wrong frame, not an error the caller must handle.
    pub fn set_overlay(&mut self, chrome: &Rgba) {
        let matches = self
            .overlay
            .as_ref()
            .is_some_and(|current| current == chrome);
        if matches {
            return;
        }
        self.overlay = Some(chrome.clone());
        self.each_targets(|targets| targets.overlay_staged = false);
    }

    /// Drops the chrome. The next frame is the picture alone, and no chrome is uploaded
    /// at all while there is none (the Tauri app draws its chrome in the web view).
    pub fn clear_overlay(&mut self) {
        if self.overlay.is_none() {
            return;
        }
        self.overlay = None;
        self.each_targets(|targets| targets.overlay_staged = false);
    }

    /// How strongly the chrome is painted, `0.0`–`1.0`. The picture is never dimmed.
    pub fn set_overlay_opacity(&mut self, opacity: f32) {
        self.overlay_opacity = opacity.clamp(0.0, 1.0);
    }

    fn bound(&self) -> Bound {
        let (paint, weight) = self.false_color.as_ref().map_or(
            (self.dummy_3d.view, self.dummy_3d.view),
            |(paint, weight)| (paint.view, weight.view),
        );
        Bound {
            lut: self.lut.as_ref().unwrap_or(&self.dummy_3d).view,
            paint,
            weight,
            dummy_2d: self.dummy_2d.view,
        }
    }

    fn cube_sizes(&self) -> CubeSizes {
        CubeSizes {
            lut: self.lut_size,
            false_color: self.false_color_size,
        }
    }

    /// [`render`](Self::render) without the chrome: the picture alone, for a camera
    /// another app reads.
    pub fn render_picture(
        &mut self,
        picture: &Picture<'_>,
        display: (u32, u32),
        options: GradeOptions,
    ) -> Result<Rgba, RenderError> {
        self.render_with(picture, display, options, 0.0)
    }

    /// Converts, grades, and stretches one picture into an image, with the chrome. Runs
    /// on targets of its own and waits for its own submission only: the window's targets
    /// are neither rebuilt nor waited on.
    pub fn render(
        &mut self,
        picture: &Picture<'_>,
        display: (u32, u32),
        options: GradeOptions,
    ) -> Result<Rgba, RenderError> {
        let opacity = self.overlay_opacity;
        self.render_with(picture, display, options, opacity)
    }

    fn render_with(
        &mut self,
        picture: &Picture<'_>,
        display: (u32, u32),
        options: GradeOptions,
        overlay_opacity: f32,
    ) -> Result<Rgba, RenderError> {
        check_rasters(picture, display)?;
        let bound = self.bound();
        let cubes = self.cube_sizes();
        ensure_targets(
            &self.gpu,
            &self.pipelines,
            &mut self.still,
            picture,
            display,
        )?;
        let targets = self.still.as_mut().expect("targets were just ensured");
        refresh_descriptors(&self.gpu, &self.pipelines, targets, options, bound);
        // The previous still finished inside `one_shot`, so its staging is free.
        let chrome = overlay_opacity > 0.0 && self.overlay.is_some();
        stage(
            &self.gpu,
            targets,
            picture,
            if chrome { self.overlay.as_ref() } else { None },
            &self.look_block,
        )?;

        let targets = self.still.as_ref().expect("targets were just ensured");
        let device = &self.gpu.device;
        let pipelines = &self.pipelines;
        let look = self.look;
        self.gpu.one_shot(|command| {
            record_frame(
                device,
                pipelines,
                targets,
                command,
                picture,
                options,
                cubes,
                Output {
                    framebuffer: targets.framebuffers[PASS_OVERLAY],
                    extent: vk::Extent2D {
                        width: display.0,
                        height: display.1,
                    },
                    pipeline: pipelines.pipelines[PASS_OVERLAY],
                    overlay_opacity: if chrome { overlay_opacity } else { 0.0 },
                    upload_overlay: chrome,
                    rect: None,
                    fit: PictureFit::Contain,
                    desqueeze: look.desqueeze,
                    peaking_thresholds: look.peaking_thresholds,
                },
            );
            // Safety: recording; `output` belongs to this device.
            unsafe { record_readback(device, command, targets, display) };
        })?;

        let length = (display.0 * display.1 * 4) as usize;
        let pixels = targets.readback.read_bytes(&self.gpu.device, length)?;
        Ok(Rgba {
            width: display.0,
            height: display.1,
            pixels,
        })
    }

    /// Submits one picture for an offscreen render on targets of its own and returns the
    /// **previous** one, once the GPU has finished it — the virtual camera's path. It never
    /// waits on the device: if the last submission is still running, nothing is submitted
    /// and `Ok(None)` comes back (the caller offers frames at ≤ 30 Hz, so it has always
    /// finished). No chrome. `look` replaces the renderer's look for this frame only, so a
    /// "Clean" output can drop the diagnostic views.
    pub fn render_async(
        &mut self,
        picture: &Picture<'_>,
        display: (u32, u32),
        options: GradeOptions,
        look: Option<Look>,
    ) -> Result<Option<Rgba>, RenderError> {
        check_rasters(picture, display)?;
        let finished = self.collect_async()?;
        if self.async_out.as_ref().is_some_and(|out| out.in_flight) {
            return Ok(None);
        }

        let bound = self.bound();
        let cubes = self.cube_sizes();
        let look = look.unwrap_or(self.look);
        let block = look_block(&look);
        let rebuild = self
            .async_out
            .as_ref()
            .is_none_or(|out| !out.targets.matches(picture, display));
        if rebuild {
            if let Some(old) = self.async_out.take() {
                // Safety: not in flight (collected above); idle before destroying.
                unsafe {
                    let _ = self.gpu.device.device_wait_idle();
                    old.targets.destroy(&self.gpu.device);
                    self.gpu.device.destroy_fence(old.fence, None);
                    self.gpu
                        .device
                        .free_command_buffers(self.gpu.command_pool, &[old.command]);
                }
            }
            let targets = build_targets(&self.gpu, &self.pipelines, picture, display.0, display.1)?;
            let allocate = vk::CommandBufferAllocateInfo::default()
                .command_pool(self.gpu.command_pool)
                .level(vk::CommandBufferLevel::PRIMARY)
                .command_buffer_count(1);
            // Safety: the pool belongs to this device; created objects are owned below.
            let command = match unsafe { self.gpu.device.allocate_command_buffers(&allocate) } {
                Ok(buffers) => buffers[0],
                Err(result) => {
                    unsafe { targets.destroy(&self.gpu.device) };
                    return Err(RenderError::Vulkan("vkAllocateCommandBuffers", result));
                }
            };
            let fence = match unsafe {
                self.gpu
                    .device
                    .create_fence(&vk::FenceCreateInfo::default(), None)
            } {
                Ok(fence) => fence,
                Err(result) => {
                    unsafe {
                        targets.destroy(&self.gpu.device);
                        self.gpu
                            .device
                            .free_command_buffers(self.gpu.command_pool, &[command]);
                    }
                    return Err(RenderError::Vulkan("vkCreateFence", result));
                }
            };
            self.async_out = Some(AsyncTargets {
                targets,
                command,
                fence,
                in_flight: false,
            });
        }

        let out = self
            .async_out
            .as_mut()
            .expect("async targets were just ensured");
        refresh_descriptors(&self.gpu, &self.pipelines, &mut out.targets, options, bound);
        stage(&self.gpu, &mut out.targets, picture, None, &block)?;
        let device = &self.gpu.device;
        let begin = vk::CommandBufferBeginInfo::default()
            .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT);
        // Safety: the buffer is not pending (its fence was collected); the fence is
        // unsignalled once reset and nothing waits on it.
        unsafe {
            device.reset_fences(&[out.fence]).context("vkResetFences")?;
            device
                .reset_command_buffer(out.command, vk::CommandBufferResetFlags::empty())
                .context("vkResetCommandBuffer")?;
            device
                .begin_command_buffer(out.command, &begin)
                .context("vkBeginCommandBuffer")?;
        }
        let targets = &out.targets;
        record_frame(
            device,
            &self.pipelines,
            targets,
            out.command,
            picture,
            options,
            cubes,
            Output {
                framebuffer: targets.framebuffers[PASS_OVERLAY],
                extent: vk::Extent2D {
                    width: display.0,
                    height: display.1,
                },
                pipeline: self.pipelines.pipelines[PASS_OVERLAY],
                overlay_opacity: 0.0,
                upload_overlay: false,
                rect: None,
                fit: PictureFit::Contain,
                desqueeze: look.desqueeze,
                peaking_thresholds: look.peaking_thresholds,
            },
        );
        // Safety: recording; the submission is guarded by this target's own fence.
        unsafe {
            record_readback(device, out.command, targets, display);
            device
                .end_command_buffer(out.command)
                .context("vkEndCommandBuffer")?;
            let buffers = [out.command];
            let submit = [vk::SubmitInfo::default().command_buffers(&buffers)];
            device
                .queue_submit(self.gpu.queue, &submit, out.fence)
                .context("vkQueueSubmit")?;
        }
        out.in_flight = true;
        Ok(finished)
    }

    /// The async frame, if its fence has signalled. Never waits.
    fn collect_async(&mut self) -> Result<Option<Rgba>, RenderError> {
        let Some(out) = self.async_out.as_mut() else {
            return Ok(None);
        };
        if !out.in_flight {
            return Ok(None);
        }
        // Safety: the fence belongs to this device.
        let done =
            unsafe { self.gpu.device.get_fence_status(out.fence) }.context("vkGetFenceStatus")?;
        if !done {
            return Ok(None);
        }
        out.in_flight = false;
        let (width, height) = (out.targets.display_width, out.targets.display_height);
        let pixels = out
            .targets
            .readback
            .read_bytes(&self.gpu.device, (width * height * 4) as usize)?;
        Ok(Some(Rgba {
            width,
            height,
            pixels,
        }))
    }

    /// Draws one picture to the window.
    ///
    /// `Presented::Rebuilt` means the swapchain changed and nothing was shown — call
    /// again with the same picture.
    pub fn present(
        &mut self,
        picture: &Picture<'_>,
        options: GradeOptions,
    ) -> Result<Presented, RenderError> {
        let Some((width, height)) = self.surface_size() else {
            return Err(RenderError::NotPresenting);
        };
        if width == 0 || height == 0 {
            return Ok(Presented::Rebuilt);
        }
        check_rasters(picture, (width, height))?;
        let bound = self.bound();
        let cubes = self.cube_sizes();
        ensure_targets(
            &self.gpu,
            &self.pipelines,
            &mut self.live,
            picture,
            (width, height),
        )?;
        refresh_descriptors(
            &self.gpu,
            &self.pipelines,
            self.live.as_mut().expect("targets were just ensured"),
            options,
            bound,
        );

        let begun = self
            .presenter
            .as_mut()
            .expect("a presenter was just checked")
            .begin(&self.gpu)?;
        let Some((index, command)) = begun else {
            return Ok(Presented::Rebuilt);
        };
        // `begin` waited for the sole in-flight frame. Only now is it safe to
        // overwrite the shared plane and overlay staging buffers for this frame.
        let chrome = self.overlay.is_some() && self.overlay_opacity > 0.0;
        stage(
            &self.gpu,
            self.live.as_mut().expect("targets were just ensured"),
            picture,
            if chrome { self.overlay.as_ref() } else { None },
            &self.look_block,
        )?;
        let presenter = self.presenter.as_ref().expect("still presenting");
        let framebuffer = presenter.framebuffer(index);
        let extent = presenter.extent;
        let pipeline = presenter.pipeline;

        let targets = self.live.as_ref().expect("targets were just ensured");
        record_frame(
            &self.gpu.device,
            &self.pipelines,
            targets,
            command,
            picture,
            options,
            cubes,
            Output {
                framebuffer,
                extent,
                pipeline,
                overlay_opacity: if chrome { self.overlay_opacity } else { 0.0 },
                upload_overlay: chrome,
                rect: self.picture_rect,
                fit: self.fit,
                desqueeze: self.look.desqueeze,
                peaking_thresholds: self.look.peaking_thresholds,
            },
        );

        let presenter = self.presenter.as_mut().expect("still presenting");
        presenter.end(&self.gpu, index)
    }
}

impl Drop for FeedRenderer {
    fn drop(&mut self) {
        // Safety: waiting for idle first, then destroying children before the device,
        // which `Gpu::drop` handles after this runs.
        unsafe {
            let _ = self.gpu.device.device_wait_idle();
            if let Some(mut presenter) = self.presenter.take() {
                presenter.destroy(&self.gpu);
            }
            for targets in [self.live.take(), self.still.take()].into_iter().flatten() {
                targets.destroy(&self.gpu.device);
            }
            if let Some(out) = self.async_out.take() {
                out.targets.destroy(&self.gpu.device);
                self.gpu.device.destroy_fence(out.fence, None);
                self.gpu
                    .device
                    .free_command_buffers(self.gpu.command_pool, &[out.command]);
            }
            if let Some(lut) = self.lut.take() {
                lut.destroy(&self.gpu.device);
            }
            if let Some((paint, weight)) = self.false_color.take() {
                paint.destroy(&self.gpu.device);
                weight.destroy(&self.gpu.device);
            }
            self.dummy_2d.destroy(&self.gpu.device);
            self.dummy_3d.destroy(&self.gpu.device);
            self.pipelines.destroy(&self.gpu.device);
        }
    }
}

/// The lattices bound right now, as the feed pass needs to know them.
#[derive(Debug, Clone, Copy, Default)]
struct CubeSizes {
    lut: u32,
    false_color: u32,
}

fn check_rasters(picture: &Picture<'_>, display: (u32, u32)) -> Result<(), RenderError> {
    if picture.width == 0
        || picture.height == 0
        || picture.width > MAX_RASTER
        || picture.height > MAX_RASTER
    {
        return Err(RenderError::UnsupportedRaster {
            width: picture.width,
            height: picture.height,
        });
    }
    if display.0 == 0 || display.1 == 0 || display.0 > MAX_RASTER || display.1 > MAX_RASTER {
        return Err(RenderError::UnsupportedRaster {
            width: display.0,
            height: display.1,
        });
    }
    Ok(())
}

/// Builds `slot` for this picture and display raster, unless it already matches.
fn ensure_targets(
    gpu: &Gpu,
    pipelines: &Pipelines,
    slot: &mut Option<Targets>,
    picture: &Picture<'_>,
    display: (u32, u32),
) -> Result<(), RenderError> {
    if slot
        .as_ref()
        .is_some_and(|targets| targets.matches(picture, display))
    {
        return Ok(());
    }
    if let Some(old) = slot.take() {
        // Safety: waiting for idle before destroying what a set may still point at.
        unsafe {
            let _ = gpu.device.device_wait_idle();
            old.destroy(&gpu.device);
        }
    }
    *slot = Some(build_targets(
        gpu, pipelines, picture, display.0, display.1,
    )?);
    Ok(())
}

/// Rewrites a target's descriptor sets when what they point at changed.
fn refresh_descriptors(
    gpu: &Gpu,
    pipelines: &Pipelines,
    targets: &mut Targets,
    options: GradeOptions,
    bound: Bound,
) {
    if options.peaking_on() != targets.peaking_bound {
        targets.peaking_bound = options.peaking_on();
        targets.descriptors_dirty = true;
    }
    if targets.descriptors_dirty {
        write_descriptors(gpu, pipelines, targets, bound);
        targets.descriptors_dirty = false;
    }
}

/// Copies one picture, its chrome (when there is any) and the look into a target's staging.
/// The caller has proved the target's previous submission finished.
fn stage(
    gpu: &Gpu,
    targets: &mut Targets,
    picture: &Picture<'_>,
    chrome: Option<&Rgba>,
    look: &[f32; LOOK_FLOATS],
) -> Result<(), RenderError> {
    stage_planes(gpu, targets, picture)?;
    if let Some(chrome) = chrome {
        if !targets.overlay_staged {
            stage_overlay(gpu, targets, chrome)?;
            targets.overlay_staged = true;
        }
    }
    targets.look.write_bytes(&gpu.device, as_bytes(look))
}

/// Packs the decoder's padded rows straight into the mapped staging buffers: one CPU copy
/// per plane. The GPU copy itself is recorded with the frame so a present does not need a
/// second submission.
fn stage_planes(gpu: &Gpu, targets: &Targets, picture: &Picture<'_>) -> Result<(), RenderError> {
    let (chroma_width, chroma_height) = picture.chroma_size();
    let planes: [(&[u8], usize, u32, u32); 3] = [
        (
            picture.luma,
            picture.luma_stride,
            picture.width,
            picture.height,
        ),
        (
            picture.chroma_blue,
            picture.chroma_stride,
            chroma_width,
            chroma_height,
        ),
        (
            picture.chroma_red,
            picture.chroma_stride,
            chroma_width,
            chroma_height,
        ),
    ];
    for (index, (source, stride, width, height)) in planes.iter().enumerate() {
        let width = *width as usize;
        targets.plane_staging[index].write_rows(
            &gpu.device,
            source,
            *stride,
            width,
            *height as usize,
        )?;
    }
    Ok(())
}

/// Packs the chrome into its staging buffer at the display raster. Rows and columns
/// the chrome does not reach stay transparent, so a stale HUD cannot smear.
fn stage_overlay(gpu: &Gpu, targets: &Targets, chrome: &Rgba) -> Result<(), RenderError> {
    let width = targets.display_width as usize;
    let height = targets.display_height as usize;
    let mut packed = vec![0_u8; width * height * 4];
    let rows = height.min(chrome.height as usize);
    let columns = width.min(chrome.width as usize);
    for row in 0..rows {
        let from = row * chrome.width as usize * 4;
        let to = row * width * 4;
        packed[to..to + columns * 4].copy_from_slice(&chrome.pixels[from..from + columns * 4]);
    }
    targets.overlay_staging.write_bytes(&gpu.device, &packed)
}

fn write_descriptors(gpu: &Gpu, pipelines: &Pipelines, targets: &Targets, bound: Bound) {
    let linear = pipelines.linear;
    let nearest = pipelines.nearest;
    let mask_view = if targets.peaking_bound {
        targets.peaking_mask.view
    } else {
        bound.dummy_2d
    };

    let bind = |view: vk::ImageView, sampler: vk::Sampler| {
        [vk::DescriptorImageInfo::default()
            .sampler(sampler)
            .image_view(view)
            .image_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)]
    };

    let ycbcr: Vec<_> = targets
        .planes
        .iter()
        .map(|plane| bind(plane.view, linear))
        .collect();
    let feed = [
        bind(targets.rgb.view, linear),
        bind(bound.lut, linear),
        bind(bound.paint, linear),
        bind(bound.weight, linear),
        bind(mask_view, nearest),
    ];
    let look = [vk::DescriptorBufferInfo::default()
        .buffer(targets.look.buffer)
        .offset(0)
        .range((LOOK_FLOATS * 4) as vk::DeviceSize)];
    let blit = bind(targets.graded.view, linear);
    // The chrome is rasterised at the display raster, so sampling it is 1:1 —
    // a linear filter would only soften text the operator needs to read.
    let overlay = [
        bind(targets.stretched.view, linear),
        bind(targets.overlay.view, nearest),
    ];
    let peak_blur = bind(targets.rgb.view, linear);
    let peak_mask = [
        bind(targets.rgb.view, linear),
        bind(targets.peaking_blur.view, nearest),
    ];

    let sampler = |set: vk::DescriptorSet, binding: usize| {
        vk::WriteDescriptorSet::default()
            .dst_set(set)
            .dst_binding(binding as u32)
            .descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
    };
    let mut writes = Vec::with_capacity(15);
    for (binding, image) in ycbcr.iter().enumerate() {
        writes.push(sampler(targets.sets[PASS_YCBCR], binding).image_info(image));
    }
    for (binding, image) in feed.iter().enumerate() {
        writes.push(sampler(targets.sets[PASS_FEED], binding).image_info(image));
    }
    writes.push(
        vk::WriteDescriptorSet::default()
            .dst_set(targets.sets[PASS_FEED])
            .dst_binding(LOOK_BINDING)
            .descriptor_type(vk::DescriptorType::UNIFORM_BUFFER)
            .buffer_info(&look),
    );
    for (binding, image) in overlay.iter().enumerate() {
        writes.push(sampler(targets.sets[PASS_OVERLAY], binding).image_info(image));
    }
    for (binding, image) in peak_mask.iter().enumerate() {
        writes.push(sampler(targets.sets[PASS_PEAK_MASK], binding).image_info(image));
    }
    writes.push(sampler(targets.sets[PASS_BLIT], 0).image_info(&blit));
    writes.push(sampler(targets.sets[PASS_PEAK_BLUR], 0).image_info(&peak_blur));

    // Safety: descriptors may not be rewritten while a frame that uses them is in
    // flight, so this waits first. It runs only when a bound resource changed.
    unsafe {
        let _ = gpu.device.device_wait_idle();
        gpu.device.update_descriptor_sets(&writes, &[]);
    }
}

/// Copies a target's `output` back to host memory. Safety: `command` is recording.
unsafe fn record_readback(
    device: &Device,
    command: vk::CommandBuffer,
    targets: &Targets,
    display: (u32, u32),
) {
    // Safety: the passes left `output` readable by shaders; move it to a transfer source
    // and copy it back to host memory.
    unsafe {
        transition(
            device,
            command,
            targets.output.image,
            vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL,
            vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
        );
        let region = vk::BufferImageCopy::default()
            .image_subresource(
                vk::ImageSubresourceLayers::default()
                    .aspect_mask(vk::ImageAspectFlags::COLOR)
                    .layer_count(1),
            )
            .image_extent(vk::Extent3D {
                width: display.0,
                height: display.1,
                depth: 1,
            });
        device.cmd_copy_image_to_buffer(
            command,
            targets.output.image,
            vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
            targets.readback.buffer,
            &[region],
        );
        // Make the transfer visible to the host before the fence is read.
        let barrier = vk::MemoryBarrier::default()
            .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
            .dst_access_mask(vk::AccessFlags::HOST_READ);
        device.cmd_pipeline_barrier(
            command,
            vk::PipelineStageFlags::TRANSFER,
            vk::PipelineStageFlags::HOST,
            vk::DependencyFlags::empty(),
            &[barrier],
            &[],
            &[],
        );
    }
}

/// Where one frame ends up.
struct Output {
    framebuffer: vk::Framebuffer,
    extent: vk::Extent2D,
    pipeline: vk::Pipeline,
    overlay_opacity: f32,
    /// Copy the chrome's staging into its image this frame. Without chrome the overlay
    /// pass still runs (it is the copy onto the swapchain) at opacity 0, and the
    /// display-raster upload — 3.7 MB a frame at 720p, 15 MB at 1440p — is skipped.
    upload_overlay: bool,
    /// Where the picture is fitted; the whole target when `None`.
    rect: Option<(u32, u32, u32, u32)>,
    fit: PictureFit,
    desqueeze: Desqueeze,
    /// The look's peaking ratio and gate, over the sense presets.
    peaking_thresholds: Option<[f32; 2]>,
}

/// Records plane uploads and every pass into `command`, ending in `output`.
#[allow(clippy::too_many_arguments)]
fn record_frame(
    device: &Device,
    pipelines: &Pipelines,
    targets: &Targets,
    command: vk::CommandBuffer,
    picture: &Picture<'_>,
    options: GradeOptions,
    cubes: CubeSizes,
    output: Output,
) {
    let (chroma_width, chroma_height) = picture.chroma_size();
    let plane_sizes = [
        (picture.width, picture.height),
        (chroma_width, chroma_height),
        (chroma_width, chroma_height),
    ];
    for (index, (width, height)) in plane_sizes.iter().enumerate() {
        let image = &targets.planes[index];
        // Safety: recording; every handle belongs to this device.
        unsafe {
            transition(
                device,
                command,
                image.image,
                vk::ImageLayout::UNDEFINED,
                vk::ImageLayout::TRANSFER_DST_OPTIMAL,
            );
            copy_buffer_to_image(
                device,
                command,
                targets.plane_staging[index].buffer,
                image,
                *width,
                *height,
                1,
            );
            transition(
                device,
                command,
                image.image,
                vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL,
            );
        }
    }

    // Safety: recording; the chrome's buffer and image belong to this device. The copy
    // runs every frame there is chrome, because the image's contents are not preserved
    // across the transition out of `UNDEFINED`. Without chrome the image is only made
    // sampleable; the overlay pass paints it at opacity 0.
    unsafe {
        if output.upload_overlay {
            transition(
                device,
                command,
                targets.overlay.image,
                vk::ImageLayout::UNDEFINED,
                vk::ImageLayout::TRANSFER_DST_OPTIMAL,
            );
            copy_buffer_to_image(
                device,
                command,
                targets.overlay_staging.buffer,
                &targets.overlay,
                targets.display_width,
                targets.display_height,
                1,
            );
            transition(
                device,
                command,
                targets.overlay.image,
                vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL,
            );
        } else {
            transition(
                device,
                command,
                targets.overlay.image,
                vk::ImageLayout::UNDEFINED,
                vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL,
            );
        }
    }

    let source = vk::Extent2D {
        width: picture.width,
        height: picture.height,
    };
    let source_constants: [f32; 2] = [picture.width as f32, picture.height as f32];

    draw(
        device,
        pipelines,
        &targets.sets,
        command,
        PASS_YCBCR,
        targets.framebuffers[PASS_YCBCR],
        source,
        pipelines.pipelines[PASS_YCBCR],
        // FFmpeg reports 8-bit 4:2:0 from this encoder as limited range.
        &[source_constants[0], source_constants[1], 0.0, 0.0],
        None,
    );

    if let Some(peaking) = options.peaking {
        draw(
            device,
            pipelines,
            &targets.sets,
            command,
            PASS_PEAK_BLUR,
            targets.framebuffers[PASS_PEAK_BLUR],
            source,
            pipelines.pipelines[PASS_PEAK_BLUR],
            &source_constants,
            None,
        );
        draw(
            device,
            pipelines,
            &targets.sets,
            command,
            PASS_PEAK_MASK,
            targets.framebuffers[PASS_PEAK_MASK],
            source,
            pipelines.pipelines[PASS_PEAK_MASK],
            &[
                source_constants[0],
                source_constants[1],
                output
                    .peaking_thresholds
                    .map_or(peaking.sense.ratio_threshold(), |pair| pair[0]),
                output
                    .peaking_thresholds
                    .map_or(peaking.sense.noise_gate(), |pair| pair[1]),
            ],
            None,
        );
    }

    let extent = output.extent;
    draw(
        device,
        pipelines,
        &targets.sets,
        command,
        PASS_FEED,
        targets.framebuffers[PASS_FEED],
        source,
        pipelines.pipelines[PASS_FEED],
        &feed_constants(picture, extent, options, cubes),
        None,
    );

    // The picture keeps its proportions (desqueezed when the lens squeezed it); the
    // render pass's clear paints the bars. A stretched face is a framing decision an
    // operator would make wrongly.
    let full = (0, 0, extent.width, extent.height);
    let rect = output.rect.map_or(full, |(x, y, width, height)| {
        // Clamp to the target: a hole reported before a resize lands must not paint
        // outside the framebuffer.
        let x = x.min(extent.width.saturating_sub(1));
        let y = y.min(extent.height.saturating_sub(1));
        (
            x,
            y,
            width.min(extent.width - x).max(1),
            height.min(extent.height - y).max(1),
        )
    });
    let shown = output
        .desqueeze
        .display_size((picture.width, picture.height));
    let (x, y, width, height) = fit_in(shown, rect, output.fit);
    let viewport = vk::Viewport {
        x: x as f32,
        y: y as f32,
        width: width as f32,
        height: height as f32,
        min_depth: 0.0,
        max_depth: 1.0,
    };
    // The scissor is the fitted picture clipped to the hole: a cover fit crops here.
    let left = (x.max(0) as u32).max(rect.0);
    let top = (y.max(0) as u32).max(rect.1);
    let right = ((i64::from(x) + i64::from(width)).max(0) as u32).min(rect.0 + rect.2);
    let bottom = ((i64::from(y) + i64::from(height)).max(0) as u32).min(rect.1 + rect.3);
    let scissor = vk::Rect2D {
        offset: vk::Offset2D {
            x: left as i32,
            y: top as i32,
        },
        extent: vk::Extent2D {
            width: right.saturating_sub(left).max(1),
            height: bottom.saturating_sub(top).max(1),
        },
    };

    draw(
        device,
        pipelines,
        &targets.sets,
        command,
        PASS_BLIT,
        targets.framebuffers[PASS_BLIT],
        extent,
        pipelines.pipelines[PASS_BLIT],
        // 10 asks the shader for Catmull-Rom: drawn larger than decoded, bilinear is soft.
        &[
            1.0,
            if width > picture.width || height > picture.height {
                10.0
            } else {
                0.0
            },
        ],
        Some((viewport, scissor)),
    );

    draw(
        device,
        pipelines,
        &targets.sets,
        command,
        PASS_OVERLAY,
        output.framebuffer,
        extent,
        output.pipeline,
        &[output.overlay_opacity, 0.0],
        None,
    );
}

fn feed_constants(
    picture: &Picture<'_>,
    display: vk::Extent2D,
    options: GradeOptions,
    cubes: CubeSizes,
) -> [f32; FEED_CONSTANTS] {
    let mut out = [0.0_f32; FEED_CONSTANTS];
    out[0] = picture.width as f32;
    out[1] = picture.height as f32;
    out[2] = display.width as f32;
    out[3] = display.height as f32;
    out[4] = cubes.lut as f32;
    if options.false_color && cubes.false_color >= 2 {
        out[5] = cubes.false_color as f32;
        out[6] = cubes.false_color as f32;
        out[7] = 1.0;
    }
    out[8] = f32::from(u8::from(options.split));
    out[9] = f32::from(u8::from(options.split_vertical));
    out[15] = f32::from(u8::from(options.upscale));
    out[16] = f32::from(u8::from(options.mirror));
    if let Some(zebra) = options.zebra.filter(|zebra| !zebra.is_off()) {
        if let Some(threshold) = zebra.highlight {
            out[10] = 1.0;
            out[11] = threshold;
        }
        if let Some((centre, half_width)) = zebra.midtone {
            out[12] = 1.0;
            out[13] = centre;
            out[14] = half_width;
        }
        out[20..24].copy_from_slice(&zebra.highlight_color);
        out[24..28].copy_from_slice(&zebra.midtone_color);
    }
    if let Some(peaking) = options.peaking {
        out[17] = 1.0;
        out[28..32].copy_from_slice(&peaking.color);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn draw(
    device: &Device,
    pipelines: &Pipelines,
    sets: &[vk::DescriptorSet; PASS_COUNT],
    command: vk::CommandBuffer,
    pass: usize,
    framebuffer: vk::Framebuffer,
    extent: vk::Extent2D,
    pipeline: vk::Pipeline,
    constants: &[f32],
    // Where inside `extent` the triangle lands, and what it may paint. `None` fills it.
    into: Option<(vk::Viewport, vk::Rect2D)>,
) {
    let clear = [vk::ClearValue {
        color: vk::ClearColorValue {
            float32: [0.0, 0.0, 0.0, 1.0],
        },
    }];
    let area = vk::Rect2D {
        offset: vk::Offset2D { x: 0, y: 0 },
        extent,
    };
    let begin = vk::RenderPassBeginInfo::default()
        .render_pass(pipelines.render_pass)
        .framebuffer(framebuffer)
        .render_area(area)
        .clear_values(&clear);
    let (viewport, scissor) = into.unwrap_or((
        vk::Viewport {
            x: 0.0,
            y: 0.0,
            width: extent.width as f32,
            height: extent.height as f32,
            min_depth: 0.0,
            max_depth: 1.0,
        },
        area,
    ));
    // Safety: recording; every handle belongs to this device and the constants match the
    // range declared on this pass's pipeline layout.
    unsafe {
        device.cmd_begin_render_pass(command, &begin, vk::SubpassContents::INLINE);
        device.cmd_bind_pipeline(command, vk::PipelineBindPoint::GRAPHICS, pipeline);
        device.cmd_set_viewport(command, 0, &[viewport]);
        device.cmd_set_scissor(command, 0, &[scissor]);
        device.cmd_bind_descriptor_sets(
            command,
            vk::PipelineBindPoint::GRAPHICS,
            pipelines.layouts[pass],
            0,
            &[sets[pass]],
            &[],
        );
        device.cmd_push_constants(
            command,
            pipelines.layouts[pass],
            vk::ShaderStageFlags::FRAGMENT,
            0,
            as_bytes(constants),
        );
        device.cmd_draw(command, 3, 1, 0, 0);
        device.cmd_end_render_pass(command);
    }
}

/// Safety: `command` must be recording and every handle must belong to `device`.
unsafe fn copy_buffer_to_image(
    device: &Device,
    command: vk::CommandBuffer,
    buffer: vk::Buffer,
    image: &DeviceImage,
    width: u32,
    height: u32,
    depth: u32,
) {
    let region = vk::BufferImageCopy::default()
        .image_subresource(
            vk::ImageSubresourceLayers::default()
                .aspect_mask(vk::ImageAspectFlags::COLOR)
                .layer_count(1),
        )
        .image_extent(vk::Extent3D {
            width,
            height,
            depth,
        });
    unsafe {
        device.cmd_copy_buffer_to_image(
            command,
            buffer,
            image.image,
            vk::ImageLayout::TRANSFER_DST_OPTIMAL,
            &[region],
        );
    }
}

/// Reinterprets a float slice as the bytes a push constant or upload wants.
fn as_bytes(values: &[f32]) -> &[u8] {
    // Safety: `f32` has no padding or invalid bit patterns, and the result borrows the
    // same memory for the same lifetime with a smaller alignment requirement.
    unsafe {
        std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(values))
    }
}

fn shader_module(device: &Device, spirv: &[u8]) -> Result<vk::ShaderModule, RenderError> {
    let code = ash::util::read_spv(&mut Cursor::new(spirv))
        .map_err(|_| RenderError::NoVulkan("a feed shader is not valid SPIR-V".to_string()))?;
    let info = vk::ShaderModuleCreateInfo::default().code(&code);
    // Safety: `code` outlives the call and the device is open.
    unsafe { device.create_shader_module(&info, None) }.context("vkCreateShaderModule")
}

/// Builds the final pipeline against an arbitrary render pass, so a swapchain can have
/// one in its own colour format.
pub(crate) fn present_pipeline(
    device: &Device,
    render_pass: vk::RenderPass,
    layout: vk::PipelineLayout,
    vertex: vk::ShaderModule,
    fragment: vk::ShaderModule,
) -> Result<vk::Pipeline, RenderError> {
    let mut created = create_pipelines(device, render_pass, &[layout], vertex, &[fragment])?;
    Ok(created.remove(0))
}

fn sampler(device: &Device, filter: vk::Filter) -> Result<vk::Sampler, RenderError> {
    let info = vk::SamplerCreateInfo::default()
        .mag_filter(filter)
        .min_filter(filter)
        .address_mode_u(vk::SamplerAddressMode::CLAMP_TO_EDGE)
        .address_mode_v(vk::SamplerAddressMode::CLAMP_TO_EDGE)
        .address_mode_w(vk::SamplerAddressMode::CLAMP_TO_EDGE);
    // Safety: the device is open.
    unsafe { device.create_sampler(&info, None) }.context("vkCreateSampler")
}

fn build_pipelines(gpu: &Gpu) -> Result<Pipelines, RenderError> {
    let device = &gpu.device;

    let attachment = [vk::AttachmentDescription::default()
        .format(COLOR_FORMAT)
        .samples(vk::SampleCountFlags::TYPE_1)
        .load_op(vk::AttachmentLoadOp::CLEAR)
        .store_op(vk::AttachmentStoreOp::STORE)
        .stencil_load_op(vk::AttachmentLoadOp::DONT_CARE)
        .stencil_store_op(vk::AttachmentStoreOp::DONT_CARE)
        .initial_layout(vk::ImageLayout::UNDEFINED)
        .final_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)];
    let reference = [vk::AttachmentReference::default()
        .attachment(0)
        .layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL)];
    let subpass = [vk::SubpassDescription::default()
        .pipeline_bind_point(vk::PipelineBindPoint::GRAPHICS)
        .color_attachments(&reference)];
    // Every offscreen pass is consumed by the next fragment pass. Make the
    // attachment writes visible before those shader reads; relying only on the
    // implicit layout transition is not sufficient on every Vulkan driver.
    let dependencies = [
        vk::SubpassDependency::default()
            .src_subpass(vk::SUBPASS_EXTERNAL)
            .dst_subpass(0)
            .src_stage_mask(
                vk::PipelineStageFlags::FRAGMENT_SHADER
                    | vk::PipelineStageFlags::TRANSFER
                    | vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT,
            )
            .dst_stage_mask(vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT)
            .src_access_mask(vk::AccessFlags::SHADER_READ | vk::AccessFlags::TRANSFER_READ)
            .dst_access_mask(vk::AccessFlags::COLOR_ATTACHMENT_WRITE)
            .dependency_flags(vk::DependencyFlags::BY_REGION),
        vk::SubpassDependency::default()
            .src_subpass(0)
            .dst_subpass(vk::SUBPASS_EXTERNAL)
            .src_stage_mask(vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT)
            .dst_stage_mask(
                vk::PipelineStageFlags::FRAGMENT_SHADER | vk::PipelineStageFlags::TRANSFER,
            )
            .src_access_mask(vk::AccessFlags::COLOR_ATTACHMENT_WRITE)
            .dst_access_mask(vk::AccessFlags::SHADER_READ | vk::AccessFlags::TRANSFER_READ)
            .dependency_flags(vk::DependencyFlags::BY_REGION),
    ];
    let pass_info = vk::RenderPassCreateInfo::default()
        .attachments(&attachment)
        .subpasses(&subpass)
        .dependencies(&dependencies);
    // Safety: every borrowed slice outlives the call.
    let render_pass =
        unsafe { device.create_render_pass(&pass_info, None) }.context("vkCreateRenderPass")?;

    let linear = sampler(device, vk::Filter::LINEAR)?;
    let nearest = sampler(device, vk::Filter::NEAREST)?;

    let mut set_layouts = [vk::DescriptorSetLayout::null(); PASS_COUNT];
    for (index, count) in SAMPLER_COUNTS.iter().enumerate() {
        let mut bindings: Vec<_> = (0..*count)
            .map(|binding| {
                vk::DescriptorSetLayoutBinding::default()
                    .binding(binding)
                    .descriptor_type(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
                    .descriptor_count(1)
                    .stage_flags(vk::ShaderStageFlags::FRAGMENT)
            })
            .collect();
        if index == PASS_FEED {
            bindings.push(
                vk::DescriptorSetLayoutBinding::default()
                    .binding(LOOK_BINDING)
                    .descriptor_type(vk::DescriptorType::UNIFORM_BUFFER)
                    .descriptor_count(1)
                    .stage_flags(vk::ShaderStageFlags::FRAGMENT),
            );
        }
        let info = vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings);
        // Safety: `bindings` outlives the call.
        set_layouts[index] = unsafe { device.create_descriptor_set_layout(&info, None) }
            .context("vkCreateDescriptorSetLayout")?;
    }

    let constant_sizes = [16_u32, (FEED_CONSTANTS * 4) as u32, 8, 8, 16, 8];
    let mut layouts = [vk::PipelineLayout::null(); PASS_COUNT];
    for (index, size) in constant_sizes.iter().enumerate() {
        let range = [vk::PushConstantRange::default()
            .stage_flags(vk::ShaderStageFlags::FRAGMENT)
            .offset(0)
            .size(*size)];
        let single = [set_layouts[index]];
        let info = vk::PipelineLayoutCreateInfo::default()
            .set_layouts(&single)
            .push_constant_ranges(&range);
        // Safety: both borrowed slices outlive the call.
        layouts[index] = unsafe { device.create_pipeline_layout(&info, None) }
            .context("vkCreatePipelineLayout")?;
    }

    let vertex_module = shader_module(
        device,
        include_bytes!(concat!(env!("OUT_DIR"), "/fullscreen.vert.spv")),
    )?;
    let overlay_module = shader_module(
        device,
        include_bytes!(concat!(env!("OUT_DIR"), "/overlay.frag.spv")),
    )?;
    let fragments = [
        shader_module(
            device,
            include_bytes!(concat!(env!("OUT_DIR"), "/ycbcr.frag.spv")),
        )?,
        shader_module(
            device,
            include_bytes!(concat!(env!("OUT_DIR"), "/feed.frag.spv")),
        )?,
        shader_module(
            device,
            include_bytes!(concat!(env!("OUT_DIR"), "/blit.frag.spv")),
        )?,
        shader_module(
            device,
            include_bytes!(concat!(env!("OUT_DIR"), "/peaking_blur.frag.spv")),
        )?,
        shader_module(
            device,
            include_bytes!(concat!(env!("OUT_DIR"), "/peaking_mask.frag.spv")),
        )?,
        overlay_module,
    ];

    let built = create_pipelines(device, render_pass, &layouts, vertex_module, &fragments);
    // Safety: modules other than the two kept for the swapchain may go once the
    // pipelines referencing them exist.
    unsafe {
        for (index, module) in fragments.iter().enumerate() {
            if index != PASS_OVERLAY {
                device.destroy_shader_module(*module, None);
            }
        }
    }
    let built = built?;
    let pipelines: [vk::Pipeline; PASS_COUNT] = built.try_into().expect("one pipeline per pass");

    Ok(Pipelines {
        render_pass,
        linear,
        nearest,
        set_layouts,
        layouts,
        pipelines,
        vertex_module,
        overlay_module,
    })
}

/// A descriptor pool holding exactly one set per pass, and those sets.
fn allocate_sets(
    gpu: &Gpu,
    pipelines: &Pipelines,
) -> Result<(vk::DescriptorPool, [vk::DescriptorSet; PASS_COUNT]), RenderError> {
    let sizes = [
        vk::DescriptorPoolSize::default()
            .ty(vk::DescriptorType::COMBINED_IMAGE_SAMPLER)
            .descriptor_count(SAMPLER_COUNTS.iter().sum()),
        vk::DescriptorPoolSize::default()
            .ty(vk::DescriptorType::UNIFORM_BUFFER)
            .descriptor_count(1),
    ];
    let pool_info = vk::DescriptorPoolCreateInfo::default()
        .pool_sizes(&sizes)
        .max_sets(PASS_COUNT as u32);
    // Safety: `sizes` outlives the call.
    let pool = unsafe { gpu.device.create_descriptor_pool(&pool_info, None) }
        .context("vkCreateDescriptorPool")?;
    let allocate = vk::DescriptorSetAllocateInfo::default()
        .descriptor_pool(pool)
        .set_layouts(&pipelines.set_layouts);
    // Safety: the pool has room for exactly these sets.
    match unsafe { gpu.device.allocate_descriptor_sets(&allocate) } {
        Ok(allocated) => Ok((pool, allocated.try_into().expect("one set per pass"))),
        Err(result) => {
            // Safety: nothing was allocated from it.
            unsafe { gpu.device.destroy_descriptor_pool(pool, None) };
            Err(RenderError::Vulkan("vkAllocateDescriptorSets", result))
        }
    }
}

fn build_targets(
    gpu: &Gpu,
    pipelines: &Pipelines,
    picture: &Picture<'_>,
    display_width: u32,
    display_height: u32,
) -> Result<Targets, RenderError> {
    let (chroma_width, chroma_height) = picture.chroma_size();
    let plane_sizes = [
        (picture.width, picture.height),
        (chroma_width, chroma_height),
        (chroma_width, chroma_height),
    ];
    let mut planes = Vec::with_capacity(3);
    let mut plane_staging = Vec::with_capacity(3);
    for (width, height) in plane_sizes {
        planes.push(DeviceImage::new_2d(
            gpu,
            width,
            height,
            PLANE_FORMAT,
            vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST,
        )?);
        plane_staging.push(HostBuffer::new(
            gpu,
            (width as vk::DeviceSize) * (height as vk::DeviceSize),
            vk::BufferUsageFlags::TRANSFER_SRC,
        )?);
    }

    let attachment_usage = vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::SAMPLED;
    let at_source = |gpu: &Gpu| {
        DeviceImage::new_2d(
            gpu,
            picture.width,
            picture.height,
            COLOR_FORMAT,
            attachment_usage,
        )
    };
    let rgb = at_source(gpu)?;
    let graded = at_source(gpu)?;
    let peaking_blur = at_source(gpu)?;
    let peaking_mask = at_source(gpu)?;
    let stretched = DeviceImage::new_2d(
        gpu,
        display_width,
        display_height,
        COLOR_FORMAT,
        attachment_usage,
    )?;
    let output = DeviceImage::new_2d(
        gpu,
        display_width,
        display_height,
        COLOR_FORMAT,
        attachment_usage | vk::ImageUsageFlags::TRANSFER_SRC,
    )?;
    // The chrome arrives already rasterised; the GPU only samples it.
    let overlay = DeviceImage::new_2d(
        gpu,
        display_width,
        display_height,
        COLOR_FORMAT,
        vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST,
    )?;
    let overlay_staging = HostBuffer::new(
        gpu,
        (display_width as vk::DeviceSize) * (display_height as vk::DeviceSize) * 4,
        vk::BufferUsageFlags::TRANSFER_SRC,
    )?;

    let mut framebuffers = [vk::Framebuffer::null(); PASS_COUNT];
    let attachments = [
        (PASS_YCBCR, &rgb),
        (PASS_FEED, &graded),
        (PASS_BLIT, &stretched),
        (PASS_PEAK_BLUR, &peaking_blur),
        (PASS_PEAK_MASK, &peaking_mask),
        (PASS_OVERLAY, &output),
    ];
    for (pass, image) in attachments {
        let views = [image.view];
        let info = vk::FramebufferCreateInfo::default()
            .render_pass(pipelines.render_pass)
            .attachments(&views)
            .width(image.width)
            .height(image.height)
            .layers(1);
        // Safety: `views` outlives the call and the view belongs to this device.
        framebuffers[pass] =
            unsafe { gpu.device.create_framebuffer(&info, None) }.context("vkCreateFramebuffer")?;
    }

    let readback = HostBuffer::new(
        gpu,
        (display_width as vk::DeviceSize) * (display_height as vk::DeviceSize) * 4,
        vk::BufferUsageFlags::TRANSFER_DST,
    )?;
    let look = HostBuffer::new(
        gpu,
        (LOOK_FLOATS * 4) as vk::DeviceSize,
        vk::BufferUsageFlags::UNIFORM_BUFFER,
    )?;
    look.write_bytes(&gpu.device, as_bytes(&look_block(&Look::default())))?;
    let (pool, sets) = allocate_sets(gpu, pipelines)?;

    Ok(Targets {
        source_width: picture.width,
        source_height: picture.height,
        display_width,
        display_height,
        planes: [planes.remove(0), planes.remove(0), planes.remove(0)],
        plane_staging: [
            plane_staging.remove(0),
            plane_staging.remove(0),
            plane_staging.remove(0),
        ],
        rgb,
        graded,
        output,
        peaking_blur,
        peaking_mask,
        stretched,
        overlay,
        overlay_staging,
        framebuffers,
        readback,
        look,
        pool,
        sets,
        descriptors_dirty: true,
        peaking_bound: false,
        overlay_staged: false,
    })
}
fn create_pipelines(
    device: &Device,
    render_pass: vk::RenderPass,
    layouts: &[vk::PipelineLayout],
    vertex: vk::ShaderModule,
    fragments: &[vk::ShaderModule],
) -> Result<Vec<vk::Pipeline>, RenderError> {
    let vertex_input = vk::PipelineVertexInputStateCreateInfo::default();
    let assembly = vk::PipelineInputAssemblyStateCreateInfo::default()
        .topology(vk::PrimitiveTopology::TRIANGLE_LIST);
    let viewport = vk::PipelineViewportStateCreateInfo::default()
        .viewport_count(1)
        .scissor_count(1);
    let raster = vk::PipelineRasterizationStateCreateInfo::default()
        .polygon_mode(vk::PolygonMode::FILL)
        .cull_mode(vk::CullModeFlags::NONE)
        .front_face(vk::FrontFace::COUNTER_CLOCKWISE)
        .line_width(1.0);
    let multisample = vk::PipelineMultisampleStateCreateInfo::default()
        .rasterization_samples(vk::SampleCountFlags::TYPE_1);
    let blend_attachment = [vk::PipelineColorBlendAttachmentState::default()
        .color_write_mask(vk::ColorComponentFlags::RGBA)];
    let blend = vk::PipelineColorBlendStateCreateInfo::default().attachments(&blend_attachment);
    let dynamic_states = [vk::DynamicState::VIEWPORT, vk::DynamicState::SCISSOR];
    let dynamic = vk::PipelineDynamicStateCreateInfo::default().dynamic_states(&dynamic_states);

    let stages: Vec<[vk::PipelineShaderStageCreateInfo<'_>; 2]> = fragments
        .iter()
        .map(|fragment| {
            [
                vk::PipelineShaderStageCreateInfo::default()
                    .stage(vk::ShaderStageFlags::VERTEX)
                    .module(vertex)
                    .name(c"main"),
                vk::PipelineShaderStageCreateInfo::default()
                    .stage(vk::ShaderStageFlags::FRAGMENT)
                    .module(*fragment)
                    .name(c"main"),
            ]
        })
        .collect();

    let infos: Vec<_> = stages
        .iter()
        .enumerate()
        .map(|(index, stage)| {
            vk::GraphicsPipelineCreateInfo::default()
                .stages(stage)
                .vertex_input_state(&vertex_input)
                .input_assembly_state(&assembly)
                .viewport_state(&viewport)
                .rasterization_state(&raster)
                .multisample_state(&multisample)
                .color_blend_state(&blend)
                .dynamic_state(&dynamic)
                .layout(layouts[index.min(layouts.len() - 1)])
                .render_pass(render_pass)
                .subpass(0)
        })
        .collect();

    // Safety: every borrowed state struct outlives this call.
    unsafe { device.create_graphics_pipelines(vk::PipelineCache::null(), &infos, None) }
        .map_err(|(_, result)| RenderError::Vulkan("vkCreateGraphicsPipelines", result))
}
