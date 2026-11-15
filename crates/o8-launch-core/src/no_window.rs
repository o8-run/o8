//! Spawn child processes without a console window on Windows.
//!
//! Every `std::process::Command` we spawn from a GUI app on Windows opens a
//! console window unless it is created with `CREATE_NO_WINDOW`. That is not a
//! cosmetic problem: a console window the user can reach is a console window
//! the user can CLICK, and a click puts it into "Select" mode, which
//! **suspends the process**. The child then never exits and never writes its
//! output.
//!
//! That is a startup deadlock, not an annoyance. Observed on a Windows 11
//! install (2026-08-07): the `where node` probe popped a console, something
//! selected inside it, and the app hung on its splash screen forever — the
//! Node locator never returned, so the web server was never spawned and its
//! log stayed empty. There is no error message and no way for a user to guess
//! the cause.
//!
//! `.no_window()` is a no-op off Windows, so call sites stay platform-neutral.

use std::process::Command;

/// `CREATE_NO_WINDOW` from the Win32 process-creation flags. Hardcoded rather
/// than pulled from a crate: it is a stable ABI constant and this is the only
/// value we need.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait NoWindow {
    /// Spawn without allocating a console window (Windows); no-op elsewhere.
    fn no_window(&mut self) -> &mut Command;
}

impl NoWindow for Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Command {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Command {
        self
    }
}
