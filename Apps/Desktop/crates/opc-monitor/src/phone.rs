//! The viewfinder on a phone's shared feed: moved to `pm_controller::phone`
//! (docs/desktop-expo-port.md §1.E). Re-exported so the shell, the window and the tests
//! keep their paths.

pub use pm_controller::phone::*;
