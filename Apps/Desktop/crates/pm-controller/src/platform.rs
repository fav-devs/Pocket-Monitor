//! Process-wide settings a live monitor needs, shared by the Slint viewfinder and the
//! Tauri app (`docs/desktop-expo-port.md` A14, P9).

/// A viewfinder that is not the focused window is a background process to Windows 11,
/// which then coarsens its timers and can leave the picture frozen for most of a second
/// at a time. A live monitor is never idle work: opt out of power throttling and ask for
/// 1 ms timers.
pub fn keep_timers_fast() {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct PowerThrottling {
            version: u32,
            control_mask: u32,
            state_mask: u32,
        }
        #[link(name = "winmm")]
        extern "system" {
            fn timeBeginPeriod(period: u32) -> u32;
        }
        extern "system" {
            fn GetCurrentProcess() -> *mut u8;
            fn SetProcessInformation(
                process: *mut u8,
                class: i32,
                info: *const PowerThrottling,
                size: u32,
            ) -> i32;
        }
        // ProcessPowerThrottling = 4; version 1; EXECUTION_SPEED = 1 controlled, state 0
        // means "do not throttle".
        let state = PowerThrottling {
            version: 1,
            control_mask: 1,
            state_mask: 0,
        };
        // Safety: plain Win32 calls on the current process with a correctly sized struct.
        unsafe {
            SetProcessInformation(
                GetCurrentProcess(),
                4,
                &state,
                std::mem::size_of::<PowerThrottling>() as u32,
            );
            timeBeginPeriod(1);
        }
    }
}
