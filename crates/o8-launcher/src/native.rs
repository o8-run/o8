//! Main-thread AppKit lifecycle. Fixture runs explicitly disable native activation.
use crate::shutdown::Shutdown;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, PoisonError,
    },
    time::Duration,
};
type MainWork = Box<dyn FnOnce() + Send>;
/// The startup and fixture tick; at rest the loop waits for `wake` instead.
pub const TICK: Duration = Duration::from_millis(25);
/// Set by `wake` and cleared by the main loop before it looks for work.
static WOKEN: Mutex<bool> = Mutex::new(false);
static WAKE: std::sync::Condvar = std::sync::Condvar::new();
/// True once AppKit owns the main thread, which then waits in its run loop.
static APPKIT: AtomicBool = AtomicBool::new(false);
/// Wakes the main loop from any thread: a control request, a child exit, the
/// window, an update job or a stop. At rest the loop otherwise sleeps until
/// its next deadline instead of ticking.
pub fn wake() {
    let first = !std::mem::replace(
        &mut *WOKEN.lock().unwrap_or_else(PoisonError::into_inner),
        true,
    );
    WAKE.notify_all();
    #[cfg(target_os = "macos")]
    if first && APPKIT.load(Ordering::SeqCst) {
        mac::nudge();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = first;
}
fn take_woken() -> bool {
    std::mem::take(&mut *WOKEN.lock().unwrap_or_else(PoisonError::into_inner))
}
fn wait_without_appkit(limit: Option<Duration>) {
    let woken = WOKEN.lock().unwrap_or_else(PoisonError::into_inner);
    let mut woken = match limit {
        Some(limit) => {
            WAKE.wait_timeout_while(woken, limit, |woken| !*woken)
                .unwrap_or_else(PoisonError::into_inner)
                .0
        }
        None => WAKE
            .wait_while(woken, |woken| !*woken)
            .unwrap_or_else(PoisonError::into_inner),
    };
    *woken = false;
}
/// Answers a platform termination request (Quit, logout, restart): sets the stop
/// flag and starts the bounded shutdown. The platform then waits; `allow` lets it
/// exit with status 0. A stop that cannot be proven complete exits with status 1
/// instead, so a supervisor and the updater can tell the two apart. Cleanup that
/// already ran (after a failed start, while its alert is open) answers at once:
/// the alert's dialog is reaped and the status is 1.
fn terminate(stop: &AtomicBool, shutdown: &Arc<Shutdown>, on_main: fn(MainWork), allow: fn()) {
    stop.store(true, Ordering::SeqCst);
    let begun = shutdown.begin(move |complete| {
        on_main(Box::new(move || {
            if complete {
                allow();
            } else {
                std::process::exit(1);
            }
        }))
    });
    if !begun {
        on_main(Box::new(|| {
            crate::reap_dialogs(std::time::Instant::now() + Duration::from_millis(400));
            std::process::exit(1)
        }));
    }
}
static FAKE_MAIN_QUEUE: Mutex<Option<mpsc::Sender<MainWork>>> = Mutex::new(None);
/// Debug-build stand-in for AppKit termination, driven through files by the
/// fixture tests. The system accepts Quit only once the launcher's event loop
/// has run (live: `terminate` returned false while the main thread had not yet
/// pumped events, true once it had), so the first pump publishes
/// `terminate-ready`. A delivered Quit waits for the next pump, which answers it
/// as AppKit does: the main thread waits inside termination, draining only the
/// main queue, and an allowed termination exits with status 0.
struct Fake {
    dir: PathBuf,
    stop: Arc<AtomicBool>,
    shutdown: Arc<Shutdown>,
    main_queue: mpsc::Receiver<MainWork>,
}
impl Fake {
    fn new(enabled: bool, stop: &Arc<AtomicBool>, shutdown: &Arc<Shutdown>) -> Option<Self> {
        if !cfg!(debug_assertions) || enabled {
            return None;
        }
        let dir = PathBuf::from(std::env::var_os("O8_LAUNCHER_FAKE_TERMINATE")?);
        let (send, main_queue) = mpsc::channel();
        *FAKE_MAIN_QUEUE
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(send);
        Some(Self {
            dir,
            stop: stop.clone(),
            shutdown: shutdown.clone(),
            main_queue,
        })
    }
    fn pump(&self) {
        let _ = std::fs::write(self.dir.join("terminate-ready"), b"1");
        if std::fs::remove_file(self.dir.join("terminate-request")).is_err() {
            return;
        }
        terminate(
            &self.stop,
            &self.shutdown,
            |work| {
                if let Some(queue) = FAKE_MAIN_QUEUE
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                {
                    let _ = queue.send(work);
                }
            },
            || std::process::exit(0),
        );
        // AppKit's wait: no launcher code runs here except main-queue work.
        while let Ok(work) = self.main_queue.recv() {
            work();
        }
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}
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
        MainThreadMarker, NSArray, NSDate, NSDefaultRunLoopMode, NSObject, NSObjectProtocol,
        NSString,
    };
    use std::{
        ffi::{CStr, OsStr},
        os::unix::ffi::OsStrExt,
        process::Command,
    };
    struct State {
        stop: Arc<AtomicBool>,
        show: Arc<AtomicBool>,
        shutdown: Arc<Shutdown>,
    }
    // The main queue still drains while AppKit waits inside `terminate:`.
    #[repr(C)]
    struct DispatchQueue {
        _opaque: [u8; 0],
    }
    extern "C" {
        static _dispatch_main_q: DispatchQueue;
        fn dispatch_async_f(
            queue: *const DispatchQueue,
            context: *mut std::ffi::c_void,
            work: extern "C" fn(*mut std::ffi::c_void),
        );
    }
    extern "C" fn run_on_main(context: *mut std::ffi::c_void) {
        let work = unsafe { Box::from_raw(context.cast::<MainWork>()) };
        work();
    }
    fn on_main(work: MainWork) {
        let context = Box::into_raw(Box::new(work)).cast();
        unsafe { dispatch_async_f(&_dispatch_main_q, context, run_on_main) };
    }
    extern "C" fn nothing(_: *mut std::ffi::c_void) {}
    /// Main-queue work ends the run-loop wait in `Native::wait`.
    pub(super) fn nudge() {
        unsafe { dispatch_async_f(&_dispatch_main_q, std::ptr::null_mut(), nothing) };
    }
    type CFStringRef = *const std::ffi::c_void;
    const RUN_FINISHED: i32 = 1;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFRunLoopDefaultMode: CFStringRef;
        fn CFRunLoopRunInMode(mode: CFStringRef, seconds: f64, after_source: u8) -> i32;
    }
    fn allow() {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(true);
        }
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
            #[unsafe(method(application:openFiles:))]
            fn open_files(&self, app: &NSApplication, paths: &NSArray<NSString>) {
                for i in 0..paths.count() {
                    crate::documents::enqueue(PathBuf::from(paths.objectAtIndex(i).to_string()));
                }
                self.ivars().show.store(true, Ordering::SeqCst);
                app.replyToOpenOrPrint(objc2_app_kit::NSApplicationDelegateReply::Success);
            }
            #[unsafe(method(applicationShouldTerminate:))]
            fn quit(&self, _: &NSApplication) -> NSApplicationTerminateReply {
                let state = self.ivars();
                // The main thread stays inside AppKit's wait from here until the
                // reply, so servers stop on the coordinator's thread.
                terminate(&state.stop, &state.shutdown, on_main, allow);
                NSApplicationTerminateReply::TerminateLater
            }
        }
    );
    pub struct Native {
        app: Option<Retained<NSApplication>>,
        _delegate: Option<Retained<LauncherDelegate>>,
        fake: Option<Fake>,
    }
    impl Native {
        pub fn new(
            enabled: bool,
            stop: Arc<AtomicBool>,
            show: Arc<AtomicBool>,
            shutdown: Arc<Shutdown>,
        ) -> Result<Self, String> {
            if !enabled {
                return Ok(Self {
                    app: None,
                    _delegate: None,
                    fake: Fake::new(enabled, &stop, &shutdown),
                });
            }
            let mtm = MainThreadMarker::new().ok_or("Native lifecycle requires the main thread")?;
            let app = NSApplication::sharedApplication(mtm);
            let allocated = LauncherDelegate::alloc(mtm).set_ivars(State {
                stop,
                show,
                shutdown,
            });
            let delegate: Retained<LauncherDelegate> = unsafe { msg_send![super(allocated), init] };
            app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
            app.finishLaunching();
            APPKIT.store(true, Ordering::SeqCst);
            Ok(Self {
                app: Some(app),
                _delegate: Some(delegate),
                fake: None,
            })
        }
        pub fn pump(&self) {
            if let Some(fake) = &self.fake {
                fake.pump();
            }
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
        /// Sleeps until `wake`, an AppKit event or `limit`; `pump` then
        /// dispatches the events. Debug fixtures keep their 25 ms tick.
        pub fn wait(&self, limit: Option<Duration>) {
            let limit = if self.fake.is_some() {
                Some(super::TICK)
            } else {
                limit
            };
            if self.app.is_none() {
                return wait_without_appkit(limit);
            }
            if take_woken() {
                return;
            }
            let seconds = limit.map_or(1.0e9, |limit| limit.as_secs_f64());
            let ran = autoreleasepool(|_| unsafe {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, 1)
            });
            if ran == RUN_FINISHED {
                // A mode without sources returns at once; never spin on it.
                wait_without_appkit(limit);
            }
            take_woken();
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
            // A pending termination never returns here: its reply comes from the
            // shutdown coordinator and AppKit then exits the process.
            if let Some(app) = &self.app {
                app.setDelegate(None);
            }
        }
    }
}
#[cfg(target_os = "macos")]
pub use mac::Native;
#[cfg(not(target_os = "macos"))]
pub struct Native {
    fake: Option<Fake>,
}
#[cfg(not(target_os = "macos"))]
impl Native {
    pub fn new(
        enabled: bool,
        stop: Arc<AtomicBool>,
        _: Arc<AtomicBool>,
        shutdown: Arc<Shutdown>,
    ) -> Result<Self, String> {
        Ok(Self {
            fake: Fake::new(enabled, &stop, &shutdown),
        })
    }
    pub fn pump(&self) {
        if let Some(fake) = &self.fake {
            fake.pump();
        }
    }
    pub fn wait(&self, limit: Option<Duration>) {
        wait_without_appkit(if self.fake.is_some() {
            Some(TICK)
        } else {
            limit
        });
    }
    pub fn focus(&self, _: u32, _: &Path) -> bool {
        false
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_wake_ends_an_unbounded_wait_and_is_never_lost() {
        // Sent before the wait: returns at once instead of sleeping forever.
        wake();
        wait_without_appkit(None);
        // Sent from another thread while the loop sleeps.
        let waker = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(50));
            wake();
        });
        wait_without_appkit(None);
        waker.join().unwrap();
        // A bounded wait ends at its limit without a wake.
        let start = std::time::Instant::now();
        wait_without_appkit(Some(Duration::from_millis(20)));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
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
