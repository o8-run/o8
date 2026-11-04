//! Opt-in snapshot hotkey: both Shift keys together capture the screen, or the
//! frontmost window, into a new chat. The choice is saved on this machine only,
//! like the appearance. The macOS monitor exists only while the setting is on.
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

/// The second Shift must go down within this window of the first.
pub(crate) const CHORD_WINDOW: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Mode {
    #[default]
    Off,
    Screen,
    Window,
}
impl Mode {
    fn parse(text: &str) -> Self {
        match text.trim() {
            "screen" => Self::Screen,
            "window" => Self::Window,
            _ => Self::Off,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Screen => "screen",
            Self::Window => "window",
        }
    }
}

#[cfg(test)]
thread_local! {
    // Each GPUI test runs on its own thread; a saved file would leak between them.
    static SAVED: std::cell::Cell<Mode> = const { std::cell::Cell::new(Mode::Off) };
}
#[cfg(not(test))]
fn saved_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".o8/next-snapshot-hotkey"))
}
/// The saved choice; off when nothing was saved.
pub(crate) fn mode() -> Mode {
    #[cfg(test)]
    return SAVED.with(|saved| saved.get());
    #[cfg(not(test))]
    saved_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|text| Mode::parse(&text))
        .unwrap_or_default()
}
pub(crate) fn set_mode(mode: Mode) {
    #[cfg(test)]
    return SAVED.with(|saved| saved.set(mode));
    #[cfg(not(test))]
    if let Some(path) = saved_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, mode.name());
    }
}

/// One Shift transition: which key, whether it went down, and when.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Shift {
    pub right: bool,
    pub down: bool,
    pub at: Duration,
}

/// Fires once when the second Shift goes down within [`CHORD_WINDOW`] of the
/// first. Holding one Shift to type and pressing the other later does not fire.
#[derive(Default)]
pub(crate) struct Chord {
    down: [Option<Duration>; 2],
    // Set when the chord fires; cleared only once both keys are up.
    fired: bool,
}
impl Chord {
    pub(crate) fn shift(&mut self, event: Shift) -> bool {
        let (this, other) = (usize::from(event.right), usize::from(!event.right));
        if !event.down {
            self.down[this] = None;
            if self.down[other].is_none() {
                self.fired = false;
            }
            return false;
        }
        if self.down[this].is_some() {
            return false;
        }
        self.down[this] = Some(event.at);
        let fired = !self.fired
            && self.down[other].is_some_and(|first| event.at.abs_diff(first) <= CHORD_WINDOW);
        self.fired |= fired;
        fired
    }
}

/// Where the System Settings prompt sends the operator.
pub(crate) const PERMISSION_PATH: &str =
    "System Settings › Privacy & Security › Input Monitoring (or Accessibility)";

/// Whether this process may observe Shift in other apps. `prompt` asks macOS
/// to show its permission prompt when the answer is no.
#[cfg(target_os = "macos")]
pub(crate) fn permitted(prompt: bool) -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOHIDCheckAccess(request: u32) -> u32;
        fn IOHIDRequestAccess(request: u32) -> bool;
    }
    // kIOHIDRequestTypeListenEvent = 1; kIOHIDAccessTypeGranted = 0.
    let granted = unsafe { AXIsProcessTrusted() || IOHIDCheckAccess(1) == 0 };
    if !granted && prompt {
        unsafe { IOHIDRequestAccess(1) };
    }
    granted
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn permitted(_prompt: bool) -> bool {
    false
}

/// Unregisters the monitor when dropped.
pub(crate) type Monitor = Box<dyn std::any::Any>;

/// Global and local flags-changed monitors; the local one sees Shift while o8
/// itself is frontmost, which a global monitor never reports.
#[cfg(target_os = "macos")]
pub(crate) fn register(sender: async_channel::Sender<Shift>) -> Option<Monitor> {
    use block::ConcreteBlock;
    use objc::{class, msg_send, runtime::Object, sel, sel_impl};
    // NSEventMaskFlagsChanged; kVK_Shift / kVK_RightShift; NX_DEVICE{L,R}SHIFTKEYMASK.
    const FLAGS_CHANGED: u64 = 1 << 12;
    fn read(event: *mut Object) -> Option<Shift> {
        let (key, flags, at): (u16, u64, f64) = unsafe {
            (
                msg_send![event, keyCode],
                msg_send![event, modifierFlags],
                msg_send![event, timestamp],
            )
        };
        let (right, mask) = match key {
            56 => (false, 0x2),
            60 => (true, 0x4),
            _ => return None,
        };
        Some(Shift {
            right,
            down: flags & mask != 0,
            at: Duration::from_secs_f64(at.max(0.)),
        })
    }
    struct Monitors(Vec<*mut Object>);
    impl Drop for Monitors {
        fn drop(&mut self) {
            for monitor in self.0.drain(..) {
                unsafe {
                    let _: () = msg_send![class!(NSEvent), removeMonitor: monitor];
                    let _: () = msg_send![monitor, release];
                }
            }
        }
    }
    let global_sender = sender.clone();
    let global = ConcreteBlock::new(move |event: *mut Object| {
        if let Some(shift) = read(event) {
            let _ = global_sender.try_send(shift);
        }
    })
    .copy();
    let local = ConcreteBlock::new(move |event: *mut Object| -> *mut Object {
        if let Some(shift) = read(event) {
            let _ = sender.try_send(shift);
        }
        event
    })
    .copy();
    let mut monitors = Monitors(vec![]);
    unsafe {
        let global: *mut Object = msg_send![class!(NSEvent), addGlobalMonitorForEventsMatchingMask: FLAGS_CHANGED handler: &*global];
        let local: *mut Object = msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: FLAGS_CHANGED handler: &*local];
        for monitor in [global, local] {
            if !monitor.is_null() {
                let _: *mut Object = msg_send![monitor, retain];
                monitors.0.push(monitor);
            }
        }
    }
    (!monitors.0.is_empty()).then(|| Box::new(monitors) as Monitor)
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn register(_sender: async_channel::Sender<Shift>) -> Option<Monitor> {
    None
}

/// Where a new capture is written; it stays on disk so the agent can open it.
pub(crate) fn capture_path() -> Option<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(home.join(format!(".o8/next/snapshots/snapshot-{stamp}.png")))
}

/// Captures with the system `screencapture` tool, as the desktop does. The
/// window mode targets the frontmost app's front window, before o8 activates.
pub(crate) fn capture(mode: Mode, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Could not save the snapshot.")?;
    }
    let mut command = std::process::Command::new("screencapture");
    command.arg("-x");
    match (mode == Mode::Window).then(frontmost_window).flatten() {
        Some(id) => command.args(["-o", "-l", &id.to_string()]),
        None => command.arg("-m"),
    };
    let status = command
        .arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| "Could not run screencapture.")?;
    if !status.success() || !path.is_file() {
        return Err("The snapshot failed. Allow o8 under System Settings › Privacy & Security › Screen & System Audio Recording.".into());
    }
    // Retina captures can exceed the composer's 5 MiB image limit.
    if std::fs::metadata(path).is_ok_and(|m| m.len() > 5 * 1024 * 1024) {
        let _ = std::process::Command::new("sips")
            .args(["-Z", "2048"])
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    Ok(())
}

/// The window number of the frontmost app's front normal window.
#[cfg(target_os = "macos")]
fn frontmost_window() -> Option<i64> {
    use objc::{class, msg_send, runtime::Object, sel, sel_impl};
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative: u32) -> *mut Object;
    }
    // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements.
    const ON_SCREEN: u32 = 1 | 16;
    unsafe fn number(dict: *mut Object, key: &str) -> Option<i64> {
        let key: *mut Object = unsafe {
            msg_send![class!(NSString), stringWithUTF8String: std::ffi::CString::new(key).ok()?.as_ptr()]
        };
        let value: *mut Object = unsafe { msg_send![dict, objectForKey: key] };
        (!value.is_null()).then(|| unsafe { msg_send![value, longLongValue] })
    }
    unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut Object = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return None;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        // The array is ordered front to back and toll-free bridged to NSArray.
        let windows = CGWindowListCopyWindowInfo(ON_SCREEN, 0);
        if windows.is_null() {
            return None;
        }
        let count: usize = msg_send![windows, count];
        let found = (0..count).find_map(|index| {
            let info: *mut Object = msg_send![windows, objectAtIndex: index];
            (number(info, "kCGWindowOwnerPID") == Some(i64::from(pid))
                && number(info, "kCGWindowLayer") == Some(0))
            .then(|| number(info, "kCGWindowNumber"))
            .flatten()
        });
        let _: () = msg_send![windows, release];
        found
    }
}
#[cfg(not(target_os = "macos"))]
fn frontmost_window() -> Option<i64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }
    fn press(chord: &mut Chord, right: bool, ms: u64) -> bool {
        chord.shift(Shift {
            right,
            down: true,
            at: at(ms),
        })
    }
    fn release(chord: &mut Chord, right: bool, ms: u64) -> bool {
        chord.shift(Shift {
            right,
            down: false,
            at: at(ms),
        })
    }

    #[test]
    fn snapshot_chord_both_shifts_within_window_fire_once() {
        let mut chord = Chord::default();
        assert!(!press(&mut chord, false, 1_000));
        assert!(press(&mut chord, true, 1_120), "second Shift 120 ms later");
        // Key repeat or releasing one key while the other is held never refires.
        assert!(!press(&mut chord, true, 1_130));
        assert!(!release(&mut chord, false, 1_200));
        assert!(!press(&mut chord, false, 1_210));
        assert!(!release(&mut chord, true, 1_300));
        assert!(!release(&mut chord, false, 1_300));
        // Either order works once both were released.
        assert!(!press(&mut chord, true, 2_000));
        assert!(press(&mut chord, false, 2_150), "exactly at the window");
    }

    #[test]
    fn snapshot_chord_one_shift_alone_never_fires() {
        let mut chord = Chord::default();
        for start in [0, 500, 1_000] {
            assert!(!press(&mut chord, false, start));
            assert!(!release(&mut chord, false, start + 40));
        }
        // A quick double tap of the same Shift is not the chord.
        assert!(!press(&mut chord, true, 2_000));
        assert!(!release(&mut chord, true, 2_030));
        assert!(!press(&mut chord, true, 2_060));
    }

    #[test]
    fn snapshot_chord_slow_second_press_does_not_fire() {
        let mut chord = Chord::default();
        // Holding Shift to type capitals, then pressing the other one later.
        assert!(!press(&mut chord, false, 1_000));
        assert!(!press(&mut chord, true, 1_151));
        assert!(!release(&mut chord, true, 1_400));
        assert!(!release(&mut chord, false, 1_500));
        // A released first press does not count toward a later chord.
        assert!(!press(&mut chord, false, 3_000));
        assert!(!release(&mut chord, false, 3_050));
        assert!(!press(&mut chord, true, 3_100));
    }

    #[test]
    fn snapshot_hotkey_mode_is_off_until_saved() {
        assert_eq!(mode(), Mode::Off);
        set_mode(Mode::Window);
        assert_eq!(mode(), Mode::Window);
        assert_eq!(Mode::parse(Mode::Window.name()), Mode::Window);
        assert_eq!(Mode::parse("garbage"), Mode::Off);
        set_mode(Mode::Off);
    }
}
