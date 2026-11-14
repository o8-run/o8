//! Main-thread AppKit lifecycle. Fixture runs explicitly disable native activation.
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};
pub fn owned_window(
    parent: Option<u32>,
    api: u32,
    executable: Option<&Path>,
    expected: &Path,
) -> bool {
    api != 0 && parent == Some(api) && executable == Some(expected)
}
#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2::{
        rc::{autoreleasepool, Retained},
        runtime::ProtocolObject,
    };
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationOptions, NSApplicationActivationPolicy,
        NSApplicationDelegate, NSApplicationTerminateReply, NSEventMask, NSRunningApplication,
    };
    use objc2_foundation::{
        MainThreadMarker, NSDate, NSDefaultRunLoopMode, NSObject, NSObjectProtocol,
    };
    use std::sync::atomic::Ordering;
    use std::{
        ffi::{CStr, OsStr},
        os::unix::ffi::OsStrExt,
        process::Command,
    };
    #[derive(Debug)]
    struct State {
        stop: Arc<AtomicBool>,
        show: Arc<AtomicBool>,
    }
    define_class!(
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[ivars = State]
        struct LauncherDelegate;
        unsafe impl NSObjectProtocol for LauncherDelegate {}
        unsafe impl NSApplicationDelegate for LauncherDelegate {
            #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
            fn reopen(&self, _: &NSApplication, _: bool) -> bool {
                self.ivars().show.store(true, Ordering::SeqCst);
                false
            }
            #[unsafe(method(applicationShouldTerminate:))]
            fn quit(&self, _: &NSApplication) -> NSApplicationTerminateReply {
                self.ivars().stop.store(true, Ordering::SeqCst);
                NSApplicationTerminateReply::TerminateCancel
            }
        }
    );
    pub struct Native {
        app: Option<Retained<NSApplication>>,
        _delegate: Option<Retained<LauncherDelegate>>,
    }
    impl Native {
        pub fn new(
            enabled: bool,
            stop: Arc<AtomicBool>,
            show: Arc<AtomicBool>,
        ) -> Result<Self, String> {
            if !enabled {
                return Ok(Self {
                    app: None,
                    _delegate: None,
                });
            }
            let mtm = MainThreadMarker::new().ok_or("Native lifecycle requires the main thread")?;
            let app = NSApplication::sharedApplication(mtm);
            let allocated = LauncherDelegate::alloc(mtm).set_ivars(State { stop, show });
            let delegate: Retained<LauncherDelegate> = unsafe { msg_send![super(allocated), init] };
            app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
            app.finishLaunching();
            Ok(Self {
                app: Some(app),
                _delegate: Some(delegate),
            })
        }
        pub fn pump(&self) {
            if let Some(app) = &self.app {
                autoreleasepool(|_| {
                    while let Some(event) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
                        NSEventMask::Any,
                        Some(&NSDate::distantPast()),
                        unsafe { NSDefaultRunLoopMode },
                        true,
                    ) {
                        app.sendEvent(&event);
                    }
                });
            }
        }
        pub fn focus(&self, api: u32, expected: &Path) -> bool {
            if self.app.is_none() {
                return false;
            }
            let Ok(expected) = std::fs::canonicalize(expected) else {
                return false;
            };
            let Ok(children) = Command::new("pgrep")
                .args(["-P", &api.to_string()])
                .output()
            else {
                return false;
            };
            for pid in String::from_utf8_lossy(&children.stdout)
                .lines()
                .filter_map(|value| value.parse::<u32>().ok())
            {
                let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
                if unsafe {
                    libc::proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32)
                } <= 0
                {
                    continue;
                }
                let path = std::fs::canonicalize(Path::new(OsStr::from_bytes(
                    unsafe { CStr::from_ptr(buffer.as_ptr().cast()) }.to_bytes(),
                )))
                .ok();
                if !owned_window(
                    crate::ownership::parent(pid),
                    api,
                    path.as_deref(),
                    &expected,
                ) {
                    continue;
                }
                if let Some(app) =
                    NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)
                {
                    app.unhide();
                    if app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows) {
                        return true;
                    }
                }
            }
            false
        }
    }
    impl Drop for Native {
        fn drop(&mut self) {
            if let Some(app) = &self.app {
                app.setDelegate(None);
            }
        }
    }
}
#[cfg(target_os = "macos")]
pub use mac::Native;
#[cfg(not(target_os = "macos"))]
pub struct Native;
#[cfg(not(target_os = "macos"))]
impl Native {
    pub fn new(_: bool, _: Arc<AtomicBool>, _: Arc<AtomicBool>) -> Result<Self, String> {
        Ok(Self)
    }
    pub fn pump(&self) {}
    pub fn focus(&self, _: u32, _: &Path) -> bool {
        false
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focus_requires_this_servers_child_and_exact_executable() {
        let expected = Path::new("/fixture/native-window");
        assert!(owned_window(Some(7), 7, Some(expected), expected));
        for (parent, api, path) in [
            (Some(8), 7, Some(expected)),
            (None, 7, Some(expected)),
            (Some(7), 7, None),
            (Some(0), 0, Some(expected)),
            (Some(7), 7, Some(Path::new("/foreign/native-window"))),
        ] {
            assert!(!owned_window(parent, api, path, expected));
        }
    }
}
