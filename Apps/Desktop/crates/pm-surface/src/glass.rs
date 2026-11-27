//! The window material and the native Liquid Glass controls behind the web view's chrome.
//!
//! `docs/desktop-expo-port.md` §5.14. The picture surface (this crate's `PictureSurface`) is
//! an opaque Vulkan swapchain covering the whole window, so nothing placed *below* it can
//! show. Everything here therefore sits between the picture and the web view, and only
//! while the app shell is on screen; the full-bleed pages (monitor, Multiview, playback)
//! turn it all off and the picture is untouched.
//!
//! - **macOS**: one host view (flipped, `hitTest:` → nil, so every click stays with the
//!   `WKWebView` above it) holding, bottom to top: an `NSVisualEffectView` (sidebar
//!   material, behind-window blending, following the window's active state) under the
//!   sidebar strip; the *page*, a flat fill in the page colour right of it while native
//!   glass is on (the web then draws the page's backgrounds transparent along each glass
//!   control's ancestors, so the glass under it shows and nothing else changes); and on
//!   macOS 26+ a pool of `NSGlassEffectView`s (in an `NSGlassEffectContainerView`) at the
//!   rects the web reports, which draws those controls with a transparent background.
//! - **Windows 11**: Mica on the window (DWM), and the picture's child window slid right
//!   by the sidebar strip so DWM's backdrop shows there (`PictureSurface::set_leading_inset`).
//!   No native glass controls; the web draws them.
//!
//! The geometry and colour parsing are platform-free and tested here.

/// A rectangle: CSS px of the viewport from the web, points of the host view natively.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Multiplied through by `factor` (CSS px to points: [`points_per_css_px`]).
    pub fn scaled(&self, factor: f64) -> Self {
        Self::new(
            self.x * factor,
            self.y * factor,
            self.width * factor,
            self.height * factor,
        )
    }

    /// Finite, non-negative and with some area.
    pub fn is_drawable(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width >= 1.0
            && self.height >= 1.0
    }
}

/// An 8-bit sRGB colour with alpha.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    /// Components in 0…1, for AppKit.
    pub fn unit(&self) -> [f64; 4] {
        [self.r, self.g, self.b, self.a].map(|c| f64::from(c) / 255.0)
    }
}

/// `#rgb`, `#rrggbb` or `#rrggbbaa` (the theme's tokens). Anything else is `None`.
pub fn parse_color(text: &str) -> Option<Rgba> {
    let hex = text.trim().strip_prefix('#')?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let nibble = |i: usize| u8::from_str_radix(&hex[i..=i], 16).ok().map(|v| v * 17);
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    match hex.len() {
        3 => Some(Rgba {
            r: nibble(0)?,
            g: nibble(1)?,
            b: nibble(2)?,
            a: 255,
        }),
        6 | 8 => Some(Rgba {
            r: byte(0)?,
            g: byte(2)?,
            b: byte(4)?,
            a: if hex.len() == 8 { byte(6)? } else { 255 },
        }),
        _ => None,
    }
}

/// Points per CSS px. A CSS px is `devicePixelRatio` device pixels and a point is
/// `backingScaleFactor` of them, so this is 1 unless the page is zoomed. Bad numbers
/// (zero, NaN) count as 1.
pub fn points_per_css_px(device_pixel_ratio: f64, backing_scale: f64) -> f64 {
    let ok = |v: f64| v.is_finite() && v > 0.0;
    if ok(device_pixel_ratio) && ok(backing_scale) {
        device_pixel_ratio / backing_scale
    } else {
        1.0
    }
}

/// The two styles AppKit documents for `NSGlassEffectView`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GlassStyle {
    #[default]
    Regular,
    Clear,
}

/// One control the web wants drawn on native glass.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlassItem {
    /// CSS px of the viewport.
    pub rect: Rect,
    /// Corner radius, CSS px.
    pub radius: f64,
    /// A tint over the glass (the primary button's ink), or none.
    pub tint: Option<Rgba>,
    pub style: GlassStyle,
    /// A flat fill under the glass: the page colour behind a toolbar button, since the
    /// native glass sees the (black) picture surface, not the web page above it. None on
    /// the sidebar, where the window material is under it.
    pub underlay: Option<Rgba>,
    /// Pinned to the window's trailing edge (toolbar actions), so a live resize keeps it
    /// in place until the web's next rects arrive.
    pub trailing: bool,
}

impl GlassItem {
    /// From the web's report: `tint` and `underlay` as `#rrggbb[aa]` (anything else is
    /// none), `style` `"clear"` or regular.
    pub fn from_web(
        rect: Rect,
        radius: f64,
        tint: Option<&str>,
        style: Option<&str>,
        underlay: Option<&str>,
        trailing: bool,
    ) -> Self {
        let radius = if radius.is_finite() {
            radius.max(0.0)
        } else {
            0.0
        };
        Self {
            rect,
            radius: radius.min(rect.width.min(rect.height).max(0.0) / 2.0),
            tint: tint.and_then(parse_color),
            style: match style {
                Some("clear") => GlassStyle::Clear,
                _ => GlassStyle::Regular,
            },
            underlay: underlay.and_then(parse_color),
            trailing,
        }
    }
}

/// The window material this platform can put behind the sidebar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Material {
    None,
    /// `NSVisualEffectView`, sidebar material (macOS).
    Vibrancy,
    /// DWM Mica (Windows 11).
    Mica,
}

impl Material {
    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Vibrancy => "vibrancy",
            Self::Mica => "mica",
        }
    }
}

/// What this machine supports, reported to the web at start-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub material: Material,
    /// `NSGlassEffectView` exists (macOS 26+).
    pub glass_controls: bool,
}

/// What this machine supports. Cheap; call it on any thread.
pub fn capabilities() -> Capabilities {
    platform::capabilities()
}

#[cfg(target_os = "macos")]
pub use platform::GlassHost;

#[cfg(windows)]
pub use platform::{apply_mica, clear_mica};

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, NSObjectProtocol};
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSBox, NSBoxType, NSColor, NSGlassEffectContainerView,
        NSGlassEffectView, NSGlassEffectViewStyle, NSTitlePosition, NSView,
        NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
        NSVisualEffectView, NSWindowOrderingMode,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    use super::{points_per_css_px, Capabilities, GlassItem, GlassStyle, Material, Rect, Rgba};

    define_class!(
        /// A plain, flipped (top-left origin, like CSS) view that never takes a click:
        /// `hitTest:` answers nil, so AppKit skips it and everything inside it.
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[name = "PMGlassPassthroughView"]
        struct PassthroughView;

        unsafe impl NSObjectProtocol for PassthroughView {}

        impl PassthroughView {
            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _point: NSPoint) -> *mut NSView {
                std::ptr::null_mut()
            }

            #[unsafe(method(isFlipped))]
            fn is_flipped(&self) -> bool {
                true
            }
        }
    );

    fn passthrough(mtm: MainThreadMarker, frame: NSRect) -> Retained<NSView> {
        // Safety: `initWithFrame:` on a fresh NSView subclass, on the main thread.
        let view: Retained<PassthroughView> =
            unsafe { msg_send![PassthroughView::alloc(mtm), initWithFrame: frame] };
        Retained::into_super(view)
    }

    fn ns_rect(rect: Rect) -> NSRect {
        NSRect::new(
            NSPoint::new(rect.x, rect.y),
            NSSize::new(rect.width, rect.height),
        )
    }

    fn ns_color(color: Rgba) -> Retained<NSColor> {
        let [r, g, b, a] = color.unit();
        NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, a)
    }

    /// A borderless, untitled, hidden fill (`NSBox` custom: colour and corner radius
    /// without a layer).
    fn flat_box(mtm: MainThreadMarker) -> Retained<NSBox> {
        let fill = NSBox::initWithFrame(mtm.alloc(), NSRect::ZERO);
        fill.setBoxType(NSBoxType::Custom);
        fill.setTitlePosition(NSTitlePosition::NoTitle);
        fill.setBorderWidth(0.0);
        fill.setTransparent(false);
        fill.setHidden(true);
        fill
    }

    fn has_class(name: &std::ffi::CStr) -> bool {
        AnyClass::get(name).is_some()
    }

    pub fn capabilities() -> Capabilities {
        Capabilities {
            material: Material::Vibrancy,
            glass_controls: has_class(c"NSGlassEffectView"),
        }
    }

    struct Slot {
        underlay: Retained<NSBox>,
        glass: Retained<NSGlassEffectView>,
    }

    /// The views between the picture and the `WKWebView`. Main thread only (not `Send`).
    pub struct GlassHost {
        mtm: MainThreadMarker,
        webview: Retained<NSView>,
        host: Retained<NSView>,
        material: Retained<NSVisualEffectView>,
        /// The page colour right of the material while native glass is on.
        page: Retained<NSBox>,
        underlays: Retained<NSView>,
        /// Where glass views go: the container's content view, or a plain view before 26.
        glass_parent: Retained<NSView>,
        slots: Vec<Slot>,
        glass: bool,
    }

    impl std::fmt::Debug for GlassHost {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("GlassHost")
                .field("slots", &self.slots.len())
                .field("glass", &self.glass)
                .finish_non_exhaustive()
        }
    }

    fn fill() -> NSAutoresizingMaskOptions {
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable
    }

    impl GlassHost {
        /// Puts the host view directly below `webview` (the `WKWebView`), which puts it
        /// above the picture surface that was placed below the web view before it.
        ///
        /// # Safety
        /// `webview` must be the live `WKWebView` of a window, on the main thread.
        pub unsafe fn attach(webview: *mut c_void) -> Result<Self, String> {
            let mtm = MainThreadMarker::new().ok_or("the window material needs the main thread")?;
            // Safety: the caller vouches that this is the live WKWebView.
            let webview: Retained<NSView> =
                unsafe { Retained::retain(webview.cast::<NSView>()).ok_or("no web view")? };
            // Safety: a live view on the main thread.
            let Some(superview) = (unsafe { webview.superview() }) else {
                return Err("the WKWebView has no parent view".to_string());
            };
            let frame = webview.frame();
            let bounds = NSRect::new(NSPoint::new(0.0, 0.0), frame.size);
            let host = passthrough(mtm, frame);
            host.setAutoresizingMask(fill());

            let material = NSVisualEffectView::initWithFrame(mtm.alloc(), NSRect::ZERO);
            material.setMaterial(NSVisualEffectMaterial::Sidebar);
            material.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
            material.setState(NSVisualEffectState::FollowsWindowActiveState);
            material.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewHeightSizable
                    | NSAutoresizingMaskOptions::ViewMaxXMargin,
            );
            material.setHidden(true);
            host.addSubview(&material);

            let page = flat_box(mtm);
            page.setAutoresizingMask(fill());
            host.addSubview(&page);

            let underlays = passthrough(mtm, bounds);
            underlays.setAutoresizingMask(fill());
            host.addSubview(&underlays);

            let glass = has_class(c"NSGlassEffectView");
            let glass_parent = passthrough(mtm, bounds);
            glass_parent.setAutoresizingMask(fill());
            if glass && has_class(c"NSGlassEffectContainerView") {
                // Batches the glass views (one sampling pass); spacing 0 never merges them.
                let container = NSGlassEffectContainerView::initWithFrame(mtm.alloc(), bounds);
                container.setAutoresizingMask(fill());
                container.setSpacing(0.0);
                container.setContentView(Some(&glass_parent));
                host.addSubview(&container);
            } else {
                host.addSubview(&glass_parent);
            }

            superview.addSubview_positioned_relativeTo(
                &host,
                NSWindowOrderingMode::Below,
                Some(&webview),
            );
            Ok(Self {
                mtm,
                webview,
                host,
                material,
                page,
                underlays,
                glass_parent,
                slots: Vec::new(),
                glass,
            })
        }

        /// CSS px of the web view to points of the host.
        fn factor(&self, device_pixel_ratio: f64) -> f64 {
            let backing = self
                .webview
                .window()
                .map(|w| w.backingScaleFactor())
                .unwrap_or(device_pixel_ratio);
            points_per_css_px(device_pixel_ratio, backing)
        }

        /// Keeps the host right below the web view and the same size as it. A view
        /// added below the web view later (the picture, re-attached) would otherwise land
        /// between them and cover the material.
        fn keep_in_place(&self) {
            // Safety: live views on the main thread.
            let Some(superview) = (unsafe { self.webview.superview() }) else {
                return;
            };
            let views = superview.subviews().to_vec();
            let index = |view: &NSView| {
                views
                    .iter()
                    .position(|v| std::ptr::eq::<NSView>(&**v, view))
            };
            let (host, web) = (index(&self.host), index(&self.webview));
            if host.is_none() || web.is_none() || host.map(|h| h + 1) != web {
                superview.addSubview_positioned_relativeTo(
                    &self.host,
                    NSWindowOrderingMode::Below,
                    Some(&self.webview),
                );
            }
            let frame = self.webview.frame();
            if self.host.frame() != frame {
                self.host.setFrame(frame);
            }
        }

        /// The sidebar material under the leading `width` CSS px (or none), and the page
        /// colour right of `leading` CSS px (or none).
        pub fn set_material(
            &self,
            width: Option<f64>,
            page: Option<(f64, Rgba)>,
            device_pixel_ratio: f64,
        ) {
            self.keep_in_place();
            let factor = self.factor(device_pixel_ratio);
            let size = self.host.bounds().size;
            match width.filter(|w| w.is_finite() && *w >= 1.0) {
                Some(width) => {
                    let width = width * factor;
                    self.material
                        .setFrame(ns_rect(Rect::new(0.0, 0.0, width, size.height)));
                    self.material.setHidden(false);
                }
                None => self.material.setHidden(true),
            }
            match page.filter(|(leading, _)| leading.is_finite()) {
                Some((leading, color)) => {
                    let x = (leading * factor).clamp(0.0, size.width);
                    self.page
                        .setFrame(ns_rect(Rect::new(x, 0.0, size.width - x, size.height)));
                    self.page.setFillColor(&ns_color(color));
                    self.page.setHidden(false);
                }
                None => self.page.setHidden(true),
            }
        }

        /// Draws `items` on glass, reusing views; the rest are hidden. Before macOS 26 it
        /// draws nothing (the web keeps its own glass) and returns 0.
        pub fn set_items(&mut self, items: &[GlassItem], device_pixel_ratio: f64) -> usize {
            self.keep_in_place();
            if !self.glass {
                return 0;
            }
            let factor = self.factor(device_pixel_ratio);
            let mut shown = 0;
            for item in items.iter().filter(|item| item.rect.is_drawable()) {
                if self.slots.len() <= shown {
                    let slot = self.slot();
                    self.slots.push(slot);
                }
                let slot = &self.slots[shown];
                let frame = ns_rect(item.rect.scaled(factor));
                let radius = (item.radius * factor).max(0.0);
                let mask = if item.trailing {
                    NSAutoresizingMaskOptions::ViewMinXMargin
                        | NSAutoresizingMaskOptions::ViewMaxYMargin
                } else {
                    NSAutoresizingMaskOptions::ViewMaxXMargin
                        | NSAutoresizingMaskOptions::ViewMaxYMargin
                };
                slot.glass.setFrame(frame);
                slot.glass.setAutoresizingMask(mask);
                slot.glass.setCornerRadius(radius);
                slot.glass.setStyle(match item.style {
                    GlassStyle::Regular => NSGlassEffectViewStyle::Regular,
                    GlassStyle::Clear => NSGlassEffectViewStyle::Clear,
                });
                slot.glass.setTintColor(item.tint.map(ns_color).as_deref());
                slot.glass.setHidden(false);
                match item.underlay {
                    Some(color) => {
                        slot.underlay.setFrame(frame);
                        slot.underlay.setAutoresizingMask(mask);
                        slot.underlay.setCornerRadius(radius);
                        slot.underlay.setFillColor(&ns_color(color));
                        slot.underlay.setHidden(false);
                    }
                    None => slot.underlay.setHidden(true),
                }
                shown += 1;
            }
            for slot in &self.slots[shown..] {
                slot.glass.setHidden(true);
                slot.underlay.setHidden(true);
            }
            shown
        }

        fn slot(&self) -> Slot {
            let underlay = flat_box(self.mtm);
            self.underlays.addSubview(&underlay);
            let glass = NSGlassEffectView::initWithFrame(self.mtm.alloc(), NSRect::ZERO);
            glass.setHidden(true);
            self.glass_parent.addSubview(&glass);
            Slot { underlay, glass }
        }
    }

    impl Drop for GlassHost {
        fn drop(&mut self) {
            // Our own view, on the main thread (the host is not Send).
            self.host.removeFromSuperview();
        }
    }
}

#[cfg(windows)]
mod platform {
    use raw_window_handle::{RawWindowHandle, WindowHandle};

    use super::{Capabilities, Material};

    /// Mica arrived with Windows 11 (build 22000). Windows 10's Acrylic lags the window
    /// while it is dragged or resized (window-vibrancy's own warning), so it is not used.
    const MICA_BUILD: u32 = 22000;

    pub fn capabilities() -> Capabilities {
        let build = windows_version::OsVersion::current().build;
        Capabilities {
            material: if build >= MICA_BUILD {
                Material::Mica
            } else {
                Material::None
            },
            glass_controls: false,
        }
    }

    /// Mica on the top-level window, light or dark to match the web's theme.
    ///
    /// # Safety
    /// `window` must be the live top-level window handle.
    pub unsafe fn apply_mica(window: RawWindowHandle, dark: bool) -> Result<(), String> {
        // Safety: forwarded from the caller.
        let handle = unsafe { WindowHandle::borrow_raw(window) };
        window_vibrancy::apply_mica(handle, Some(dark)).map_err(|error| error.to_string())
    }

    /// # Safety
    /// As [`apply_mica`].
    pub unsafe fn clear_mica(window: RawWindowHandle) -> Result<(), String> {
        // Safety: forwarded from the caller.
        let handle = unsafe { WindowHandle::borrow_raw(window) };
        window_vibrancy::clear_mica(handle).map_err(|error| error.to_string())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::{Capabilities, Material};

    /// WebKitGTK paints the whole window; the compositor owns any blur.
    pub fn capabilities() -> Capabilities {
        Capabilities {
            material: Material::None,
            glass_controls: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_parse_in_the_theme_forms() {
        let white = Rgba {
            r: 255,
            g: 255,
            b: 255,
            a: 255,
        };
        assert_eq!(parse_color("#ffffff"), Some(white));
        assert_eq!(parse_color("#FFF"), Some(white));
        assert_eq!(
            parse_color(" #1c1c1c80 "),
            Some(Rgba {
                r: 0x1c,
                g: 0x1c,
                b: 0x1c,
                a: 0x80
            })
        );
        assert_eq!(parse_color("1c1c1c"), None);
        assert_eq!(parse_color("#12345"), None);
        assert_eq!(parse_color("#ggg"), None);
        assert_eq!(parse_color("rgba(0,0,0,1)"), None);
        assert_eq!(parse_color("#é1"), None);
    }

    #[test]
    fn unit_components_run_zero_to_one() {
        let c = parse_color("#ff000080").unwrap();
        let [r, g, b, a] = c.unit();
        assert_eq!((r, g, b), (1.0, 0.0, 0.0));
        assert!((a - 128.0 / 255.0).abs() < 1e-9);
    }

    #[test]
    fn a_css_px_is_a_point_unless_zoomed() {
        assert_eq!(points_per_css_px(2.0, 2.0), 1.0);
        assert_eq!(points_per_css_px(1.0, 1.0), 1.0);
        // Page zoomed to 125% on a Retina screen.
        assert_eq!(points_per_css_px(2.5, 2.0), 1.25);
        assert_eq!(points_per_css_px(0.0, 2.0), 1.0);
        assert_eq!(points_per_css_px(f64::NAN, 2.0), 1.0);
        assert_eq!(points_per_css_px(2.0, 0.0), 1.0);
    }

    #[test]
    fn rects_scale_and_reject_nothing_to_draw() {
        let r = Rect::new(10.0, 20.0, 30.0, 40.0).scaled(1.5);
        assert_eq!(r, Rect::new(15.0, 30.0, 45.0, 60.0));
        assert!(r.is_drawable());
        assert!(!Rect::new(0.0, 0.0, 0.5, 10.0).is_drawable());
        assert!(!Rect::new(f64::INFINITY, 0.0, 10.0, 10.0).is_drawable());
    }

    #[test]
    fn web_items_are_read_leniently() {
        let item = GlassItem::from_web(
            Rect::new(0.0, 0.0, 120.0, 32.0),
            999.0,
            Some("#1c1c1c"),
            Some("clear"),
            Some("nonsense"),
            true,
        );
        // A pill: the radius never passes half the short side.
        assert_eq!(item.radius, 16.0);
        assert_eq!(item.tint, parse_color("#1c1c1c"));
        assert_eq!(item.style, GlassStyle::Clear);
        assert_eq!(item.underlay, None);
        assert!(item.trailing);
        let plain = GlassItem::from_web(
            Rect::new(0.0, 0.0, 32.0, 32.0),
            -4.0,
            None,
            None,
            None,
            false,
        );
        assert_eq!(plain.radius, 0.0);
        assert_eq!(plain.style, GlassStyle::Regular);
        let nan = GlassItem::from_web(
            Rect::new(0.0, 0.0, 32.0, 32.0),
            f64::NAN,
            None,
            Some("x"),
            None,
            false,
        );
        assert_eq!(nan.radius, 0.0);
    }

    #[test]
    fn this_machine_reports_a_material() {
        let caps = capabilities();
        if cfg!(target_os = "linux") {
            assert_eq!(caps.material, Material::None);
            assert!(!caps.glass_controls);
        }
        assert!(["none", "vibrancy", "mica"].contains(&caps.material.name()));
    }
}
