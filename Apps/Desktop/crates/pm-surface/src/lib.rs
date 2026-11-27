//! The native surface the Vulkan picture is presented to, under the transparent web view.
//!
//! `docs/desktop-expo-port.md` §3.2. The picture never goes through the web view: the
//! web view is transparent where `<LivePicture>` sits, and this surface shows through.
//!
//! - **Windows, option A (default)**: a dedicated child `HWND` of the Tauri window, placed
//!   at `HWND_BOTTOM` (below WebView2's container), sized to the client area, answering
//!   `WM_NCHITTEST` with `HTTRANSPARENT` so every click and touch reaches WebView2, and
//!   never erasing its background so GDI cannot flash a brush over the swapchain.
//! - **Windows, option B** (`HostMode::TopLevel`): the Tauri window's own `HWND`, with the
//!   transparent WebView2 child on top. No extra window; resize ordering follows tao.
//! - **macOS**: an `NSView` inserted below the `WKWebView` in its parent view, width and
//!   height sizable. `ash-window` gives it a `CAMetalLayer` when the renderer is built
//!   (on the main thread) and MoltenVK presents to it.
//! - **Linux**: best effort. WebKitGTK paints the whole toplevel, so there is no reliable
//!   "below the web view" yet; `TopLevel` hands out the window's own handle for
//!   experiments, `Child` is refused.
//!
//! Everything here must run on the UI thread that owns the window. The handles it gives
//! out may be used from the render thread.

use raw_window_handle::{RawDisplayHandle, RawWindowHandle};

pub mod glass;

/// Where the swapchain goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HostMode {
    /// A dedicated native view below the web view (§3.2 option A).
    #[default]
    Child,
    /// The top-level window itself (§3.2 option B).
    TopLevel,
}

impl HostMode {
    /// `PM_PICTURE_HOST=toplevel` picks option B; anything else is option A.
    pub fn from_env() -> Self {
        match std::env::var("PM_PICTURE_HOST").as_deref() {
            Ok("toplevel") | Ok("b") | Ok("B") => Self::TopLevel,
            _ => Self::Child,
        }
    }
}

/// A native surface for the picture. Dropping it destroys the child view.
#[derive(Debug)]
pub struct PictureSurface {
    inner: platform::Surface,
    mode: HostMode,
}

impl PictureSurface {
    /// Attaches a surface to the window `parent`, `width` × `height` physical pixels.
    /// `webview` is the platform web view (the `WKWebView` on macOS, unused elsewhere),
    /// which the surface is placed below.
    ///
    /// # Safety
    /// `parent` (and `webview`, when given) must be live handles of a window owned by the
    /// calling thread, and must outlive the returned surface.
    pub unsafe fn attach(
        display: RawDisplayHandle,
        parent: RawWindowHandle,
        webview: Option<*mut std::ffi::c_void>,
        mode: HostMode,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        // Safety: forwarded from the caller.
        let inner =
            unsafe { platform::Surface::attach(display, parent, webview, mode, width, height)? };
        Ok(Self { inner, mode })
    }

    pub fn mode(&self) -> HostMode {
        self.mode
    }

    /// The handles `FeedRenderer::for_window` takes.
    pub fn handles(&self) -> (RawDisplayHandle, RawWindowHandle) {
        self.inner.handles()
    }

    /// Follows the window's client area (physical pixels). UI thread only.
    pub fn resize(&self, width: u32, height: u32) {
        self.inner.resize(width.max(1), height.max(1));
    }

    /// Windows: slides the picture's child window `pixels` to the right (its size, and so
    /// the swapchain, unchanged; the parent clips the overhang), leaving the window's
    /// leading strip uncovered for the Mica behind the sidebar. 0 puts it back. Only while
    /// no picture is on screen there (`glass.rs`). No-op elsewhere. UI thread only.
    pub fn set_leading_inset(&self, pixels: u32) {
        self.inner.set_leading_inset(pixels);
    }
}

#[cfg(windows)]
mod platform {
    use std::num::NonZeroIsize;
    use std::sync::OnceLock;

    use raw_window_handle::{
        RawDisplayHandle, RawWindowHandle, Win32WindowHandle, WindowsDisplayHandle,
    };
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ValidateRect;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, LoadCursorW, RegisterClassExW,
        SetWindowPos, CS_HREDRAW, CS_VREDRAW, HTTRANSPARENT, HWND_BOTTOM, IDC_ARROW,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_ERASEBKGND, WM_NCHITTEST,
        WM_PAINT, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_EX_NOPARENTNOTIFY, WS_VISIBLE,
    };

    use super::HostMode;

    #[derive(Debug)]
    pub struct Surface {
        hwnd: HWND,
        /// Destroyed on drop only when this crate created it.
        owned: bool,
        hinstance: isize,
    }

    // The HWND is only touched on the UI thread (resize, drop); the render thread only
    // reads the handle value to build its Vulkan surface.
    unsafe impl Send for Surface {}

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    unsafe extern "system" fn picture_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            // Every pointer event belongs to the web view above.
            WM_NCHITTEST => HTTRANSPARENT as LRESULT,
            // Vulkan owns every pixel: no GDI brush, ever (the white flash).
            WM_ERASEBKGND => 1,
            WM_PAINT => {
                // Safety: validating our own window's update region.
                unsafe { ValidateRect(hwnd, std::ptr::null()) };
                0
            }
            // Safety: default handling for our own window.
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    fn class_name() -> &'static [u16] {
        static CLASS: OnceLock<Vec<u16>> = OnceLock::new();
        CLASS.get_or_init(|| {
            let name = wide("PocketMonitorPicture");
            // Safety: a plain class registration with a static name and window proc.
            unsafe {
                let class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(picture_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: GetModuleHandleW(std::ptr::null()),
                    hIcon: std::ptr::null_mut(),
                    hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                    // No background brush: see WM_ERASEBKGND.
                    hbrBackground: std::ptr::null_mut(),
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: name.as_ptr(),
                    hIconSm: std::ptr::null_mut(),
                };
                RegisterClassExW(&class);
            }
            name
        })
    }

    impl Surface {
        pub unsafe fn attach(
            _display: RawDisplayHandle,
            parent: RawWindowHandle,
            _webview: Option<*mut std::ffi::c_void>,
            mode: HostMode,
            width: u32,
            height: u32,
        ) -> Result<Self, String> {
            let RawWindowHandle::Win32(parent) = parent else {
                return Err("the Tauri window gave no Win32 handle".to_string());
            };
            let parent_hwnd = parent.hwnd.get() as HWND;
            let hinstance = parent.hinstance.map_or(0, NonZeroIsize::get);
            if mode == HostMode::TopLevel {
                return Ok(Self {
                    hwnd: parent_hwnd,
                    owned: false,
                    hinstance,
                });
            }
            // Safety: creating a child of a live window on its own thread.
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_NOPARENTNOTIFY,
                    class_name().as_ptr(),
                    std::ptr::null(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                    0,
                    0,
                    width.max(1) as i32,
                    height.max(1) as i32,
                    parent_hwnd,
                    std::ptr::null_mut(),
                    GetModuleHandleW(std::ptr::null()),
                    std::ptr::null(),
                )
            };
            if hwnd.is_null() {
                return Err("CreateWindowExW failed for the picture surface".to_string());
            }
            // Below WebView2's container, so the web view's transparent pixels show it.
            // Safety: our own child window.
            unsafe {
                SetWindowPos(
                    hwnd,
                    HWND_BOTTOM,
                    0,
                    0,
                    width.max(1) as i32,
                    height.max(1) as i32,
                    SWP_NOACTIVATE,
                );
            }
            Ok(Self {
                hwnd,
                owned: true,
                hinstance: unsafe { GetModuleHandleW(std::ptr::null()) } as isize,
            })
        }

        pub fn handles(&self) -> (RawDisplayHandle, RawWindowHandle) {
            let mut handle =
                Win32WindowHandle::new(NonZeroIsize::new(self.hwnd as isize).expect("live hwnd"));
            handle.hinstance = NonZeroIsize::new(self.hinstance);
            (
                RawDisplayHandle::Windows(WindowsDisplayHandle::new()),
                RawWindowHandle::Win32(handle),
            )
        }

        pub fn resize(&self, width: u32, height: u32) {
            if !self.owned {
                return;
            }
            // Safety: our own child window, on the UI thread.
            unsafe {
                SetWindowPos(
                    self.hwnd,
                    std::ptr::null_mut(),
                    0,
                    0,
                    width as i32,
                    height as i32,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOZORDER,
                );
            }
        }

        pub fn set_leading_inset(&self, pixels: u32) {
            if !self.owned {
                return;
            }
            // Safety: our own child window, on the UI thread.
            unsafe {
                SetWindowPos(
                    self.hwnd,
                    std::ptr::null_mut(),
                    pixels.min(i32::MAX as u32) as i32,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER,
                );
            }
        }
    }

    impl Drop for Surface {
        fn drop(&mut self) {
            if self.owned {
                // Safety: our own child window, on the UI thread.
                unsafe { DestroyWindow(self.hwnd) };
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindowOrderingMode};
    use raw_window_handle::{
        AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
    };

    use super::HostMode;

    #[derive(Debug)]
    pub struct Surface {
        view: Retained<NSView>,
        owned: bool,
    }

    // The view is only touched on the main thread (resize, drop); the render thread reads
    // the handle value only. The renderer is built on the main thread (see pm-desktop).
    unsafe impl Send for Surface {}

    impl Surface {
        pub unsafe fn attach(
            _display: RawDisplayHandle,
            parent: RawWindowHandle,
            webview: Option<*mut c_void>,
            mode: HostMode,
            _width: u32,
            _height: u32,
        ) -> Result<Self, String> {
            let mtm = MainThreadMarker::new().ok_or("the picture surface needs the main thread")?;
            let RawWindowHandle::AppKit(parent) = parent else {
                return Err("the Tauri window gave no AppKit handle".to_string());
            };
            // Safety: the caller vouches that the handle is a live NSView.
            let content: Retained<NSView> = unsafe {
                Retained::retain(parent.ns_view.as_ptr().cast::<NSView>())
                    .ok_or("no content view")?
            };
            if mode == HostMode::TopLevel {
                return Ok(Self {
                    view: content,
                    owned: false,
                });
            }
            let webview: Retained<NSView> = match webview {
                // Safety: the caller vouches that this is the live WKWebView.
                Some(pointer) => unsafe {
                    Retained::retain(pointer.cast::<NSView>()).ok_or("no web view")?
                },
                None => return Err("the picture surface needs the WKWebView".to_string()),
            };
            let Some(superview) = (unsafe { webview.superview() }) else {
                return Err("the WKWebView has no parent view".to_string());
            };
            let frame = superview.bounds();
            let view = NSView::initWithFrame(mtm.alloc::<NSView>(), frame);
            view.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable,
            );
            // Both views are live and on the main thread.
            superview.addSubview_positioned_relativeTo(
                &view,
                NSWindowOrderingMode::Below,
                Some(&webview),
            );
            Ok(Self { view, owned: true })
        }

        pub fn handles(&self) -> (RawDisplayHandle, RawWindowHandle) {
            let pointer = NonNull::from(&*self.view).cast::<c_void>();
            (
                RawDisplayHandle::AppKit(AppKitDisplayHandle::new()),
                RawWindowHandle::AppKit(AppKitWindowHandle::new(pointer)),
            )
        }

        /// The view follows its parent through its autoresizing mask.
        pub fn resize(&self, _width: u32, _height: u32) {}

        /// The material sits above the picture on macOS (`glass.rs`); nothing moves.
        pub fn set_leading_inset(&self, _pixels: u32) {}
    }

    impl Drop for Surface {
        fn drop(&mut self) {
            if self.owned {
                // Our own view, on the main thread.
                self.view.removeFromSuperview();
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use raw_window_handle::{RawDisplayHandle, RawWindowHandle};

    use super::HostMode;

    #[derive(Debug)]
    pub struct Surface {
        display: RawDisplayHandle,
        window: RawWindowHandle,
    }

    // Best effort only: the toplevel's own handle, read by the render thread.
    unsafe impl Send for Surface {}

    impl Surface {
        pub unsafe fn attach(
            display: RawDisplayHandle,
            parent: RawWindowHandle,
            _webview: Option<*mut std::ffi::c_void>,
            mode: HostMode,
            _width: u32,
            _height: u32,
        ) -> Result<Self, String> {
            if mode != HostMode::TopLevel {
                return Err(
                    "no native picture under WebKitGTK yet; run with PM_PICTURE_HOST=toplevel to try the window itself"
                        .to_string(),
                );
            }
            Ok(Self {
                display,
                window: parent,
            })
        }

        pub fn handles(&self) -> (RawDisplayHandle, RawWindowHandle) {
            (self.display, self.window)
        }

        pub fn resize(&self, _width: u32, _height: u32) {}

        pub fn set_leading_inset(&self, _pixels: u32) {}
    }
}
