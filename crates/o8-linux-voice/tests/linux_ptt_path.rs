//! The production registration/hold code, hosted without starting the desktop app or a microphone.
//! Global shortcut delivery and focus/key changes use a real private X server.
#![cfg(target_os = "linux")]
#![allow(dead_code)]
extern crate self as tauri;
extern crate self as tauri_plugin_global_shortcut;

pub use global_hotkey::{
    hotkey::{HotKey as Shortcut, Modifiers},
    HotKeyState as ShortcutState,
};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager};
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::xproto::{ConnectionExt, CreateWindowAux, InputFocus, WindowClass},
    CURRENT_TIME,
};

#[path = "../../../src-tauri/src/linux_ptt.rs"]
mod linux_ptt;

#[derive(Clone)]
pub struct AppHandle;
pub struct App {
    handle: AppHandle,
    shortcuts: Shortcuts,
}
pub struct Shortcuts(GlobalHotKeyManager);
type Callback = dyn Fn(&AppHandle, &Shortcut, GlobalHotKeyEvent) + Send + Sync;
static CALLBACK: OnceLock<Mutex<Option<(Shortcut, Box<Callback>)>>> = OnceLock::new();
static PRESSES: AtomicUsize = AtomicUsize::new(0);
static PREPARES: AtomicUsize = AtomicUsize::new(0);
static RELEASE_PREPARE: AtomicBool = AtomicBool::new(false);
static RACE: AtomicBool = AtomicBool::new(false);
static STARTS: Mutex<Vec<usize>> = Mutex::new(vec![]);
static STOPS: Mutex<Vec<u64>> = Mutex::new(vec![]);

impl App {
    fn handle(&self) -> &AppHandle {
        &self.handle
    }
}
pub trait GlobalShortcutExt {
    fn global_shortcut(&self) -> &Shortcuts;
}
impl GlobalShortcutExt for App {
    fn global_shortcut(&self) -> &Shortcuts {
        &self.shortcuts
    }
}
impl Shortcuts {
    fn on_shortcut(
        &self,
        key: Shortcut,
        callback: impl Fn(&AppHandle, &Shortcut, GlobalHotKeyEvent) + Send + Sync + 'static,
    ) -> Result<(), String> {
        self.0.register(key).map_err(|e| e.to_string())?;
        *CALLBACK.get_or_init(|| Mutex::new(None)).lock().unwrap() =
            Some((key, Box::new(callback)));
        Ok(())
    }
}
mod stt {
    pub mod keys {
        pub fn config_bool(_: &str, default: bool) -> bool {
            default
        }
        pub fn config_string(_: &str) -> Option<String> {
            (std::env::var("O8_PTT_PROBE").as_deref() == Ok("custom"))
                .then(|| "Control+Alt+CapsLock".into())
        }
    }
}
mod stt_engine {
    use super::*;
    pub fn prepare_input() -> Result<usize, String> {
        let id = PREPARES.fetch_add(1, Ordering::SeqCst);
        if id == 0 && RACE.load(Ordering::SeqCst) {
            wait("first preparation released", || {
                RELEASE_PREPARE.load(Ordering::SeqCst)
            });
        }
        Ok(id)
    }
    pub fn start_prepared(input: usize, _: Option<()>) -> Result<u64, String> {
        STARTS.lock().unwrap().push(input);
        Ok(input as u64 + 1)
    }
    pub fn stop_session(id: u64) -> Result<(), String> {
        STOPS.lock().unwrap().push(id);
        Ok(())
    }
    pub fn emit_system_stt(_: &AppHandle, event: serde_json::Value) {
        if event["type"] == "error" {
            eprintln!("{event}");
        }
    }
}
mod audio_ducker {
    pub fn duck() -> Result<(), String> {
        Ok(())
    }
    pub fn restore() {}
}
mod linux_voice {
    pub fn stop_speaking() {}
}
mod fn_hotkey {
    pub fn set_system_origin(_: bool) {}
}
mod paste {
    pub enum PasteOutcome {
        Pasted,
        Failed(String),
    }
}

fn wait(label: &str, predicate: impl Fn() -> bool) {
    let start = Instant::now();
    while !predicate() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "timed out: {label}; presses={}, prepares={}",
            PRESSES.load(Ordering::SeqCst),
            PREPARES.load(Ordering::SeqCst)
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn keys(action: &str, keys: &[&str]) {
    assert!(Command::new("xdotool")
        .arg(action)
        .args(keys)
        .status()
        .unwrap()
        .success());
}

#[test]
#[ignore = "requires Xvfb and xdotool; run explicitly"]
fn ptt_focus_loss_and_foreign_keyup_stop_recording() {
    owned_probe("focus");
}

#[test]
#[ignore = "requires Xvfb and xdotool; run explicitly"]
fn ptt_released_preparation_cannot_start_a_later_hold() {
    owned_probe("race");
}

#[test]
#[ignore = "requires Xvfb and xdotool; run explicitly"]
fn ptt_configured_chord_keeps_release_monitoring() {
    owned_probe("custom");
}

#[test]
#[ignore = "requires Xvfb and xdotool; run explicitly"]
fn ptt_brief_focus_and_key_changes_end_hold() {
    owned_probe("edges");
}

#[test]
#[ignore = "requires Xvfb and xdotool; run explicitly"]
fn ptt_stalled_x_server_ends_recording() {
    owned_probe("stalled");
}

struct OwnedServer(std::process::Child);
impl Drop for OwnedServer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn owned_probe(mode: &str) {
    let mut server = OwnedServer(
        Command::new("Xvfb")
            .args([
                "-displayfd",
                "1",
                "-screen",
                "0",
                "800x600x24",
                "-nolisten",
                "tcp",
                "-ac",
                "-noreset",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("install Xvfb"),
    );
    let stdout = server.0.stdout.take().unwrap();
    let (ready, display) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = ready.send(line);
    });
    let display: u32 = display
        .recv_timeout(Duration::from_secs(5))
        .expect("X server startup")
        .trim()
        .parse()
        .expect("private X display");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "registered_probe_child",
            "--ignored",
            "--nocapture",
        ])
        .env("DISPLAY", format!(":{display}"))
        .env("XDG_SESSION_TYPE", "x11")
        .env_remove("WAYLAND_DISPLAY")
        .env("O8_PTT_PROBE", mode)
        .env("O8_PTT_SERVER", server.0.id().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("X11 hold probe timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed; 0 failed"));
}

#[test]
#[ignore = "owned child of the X11 boundary tests"]
fn registered_probe_child() {
    let (connection, screen) = x11rb::connect(None).unwrap();
    let root = connection.setup().roots[screen].root;
    let windows: Vec<_> = (0..2)
        .map(|i| {
            let id = connection.generate_id().unwrap();
            connection
                .create_window(
                    0,
                    id,
                    root,
                    i * 320,
                    0,
                    300,
                    200,
                    0,
                    WindowClass::INPUT_OUTPUT,
                    0,
                    &CreateWindowAux::new(),
                )
                .unwrap()
                .check()
                .unwrap();
            connection.map_window(id).unwrap().check().unwrap();
            id
        })
        .collect();
    let focus = |window| {
        connection
            .set_input_focus(InputFocus::PARENT, window, CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        connection.flush().unwrap();
    };
    focus(windows[0]);
    let app = App {
        handle: AppHandle,
        shortcuts: Shortcuts(GlobalHotKeyManager::new().unwrap()),
    };
    linux_ptt::register(&app);
    assert!(
        CALLBACK.get().unwrap().lock().unwrap().is_some(),
        "production shortcut registered"
    );
    std::thread::spawn(|| loop {
        if let Ok(event) = GlobalHotKeyEvent::receiver().recv_timeout(Duration::from_millis(20)) {
            let guard = CALLBACK.get().unwrap().lock().unwrap();
            let (shortcut, callback) = guard.as_ref().unwrap();
            if event.id == shortcut.id() {
                if event.state == ShortcutState::Pressed {
                    PRESSES.fetch_add(1, Ordering::SeqCst);
                }
                callback(&AppHandle, shortcut, event);
            }
        }
    });
    let mode = std::env::var("O8_PTT_PROBE").unwrap();
    if mode == "race" {
        RACE.store(true, Ordering::SeqCst);
        keys("keydown", &["Control_L", "Alt_L", "space"]);
        wait("A preparing", || PREPARES.load(Ordering::SeqCst) == 1);
        keys("keyup", &["space", "Alt_L", "Control_L"]);
        keys("keydown", &["Control_L", "Alt_L", "space"]);
        wait("B pressed", || PRESSES.load(Ordering::SeqCst) == 2);
        RELEASE_PREPARE.store(true, Ordering::SeqCst);
        wait("B started", || STARTS.lock().unwrap().contains(&1));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            *STARTS.lock().unwrap(),
            vec![1],
            "released A must never acquire B's held state"
        );
        keys("keyup", &["space", "Alt_L", "Control_L"]);
        wait("B stopped", || STOPS.lock().unwrap().contains(&2));
    } else if mode == "custom" {
        keys("keydown", &["Control_L", "Alt_L", "Caps_Lock"]);
        wait("configured chord recording", || {
            STARTS.lock().unwrap().len() == 1
        });
        focus(windows[1]);
        wait("configured chord window change", || {
            STOPS.lock().unwrap().len() == 1
        });
        keys("keyup", &["Caps_Lock", "Alt_L", "Control_L"]);
    } else if mode == "edges" {
        keys("keydown", &["Control_L", "Alt_L", "space"]);
        wait("recording", || STARTS.lock().unwrap().len() == 1);
        focus(windows[1]);
        focus(windows[0]);
        wait("brief focus transfer", || STOPS.lock().unwrap().len() == 1);
        keys("keyup", &["space", "Alt_L", "Control_L"]);
        keys("keydown", &["Control_L", "Alt_L", "space"]);
        wait("recording again", || STARTS.lock().unwrap().len() == 2);
        // One request sequence releases and re-presses before a polling tick.
        assert!(Command::new("xdotool")
            .args(["keyup", "Control_L", "keydown", "Control_L"])
            .status()
            .unwrap()
            .success());
        wait("raw modifier release", || STOPS.lock().unwrap().len() == 2);
        keys("keyup", &["space", "Alt_L", "Control_L"]);
    } else if mode == "stalled" {
        keys("keydown", &["Control_L", "Alt_L", "space"]);
        wait("recording", || STARTS.lock().unwrap().len() == 1);
        let pid = std::env::var("O8_PTT_SERVER")
            .unwrap()
            .parse::<i32>()
            .unwrap();
        // This is the private server owned by this test's parent process.
        assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
        wait("stalled server stops recording", || {
            STOPS.lock().unwrap().len() == 1
        });
        assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0);
        keys("keyup", &["space", "Alt_L", "Control_L"]);
    } else {
        keys("keydown", &["Control_L", "Alt_L", "space"]);
        wait("recording", || STARTS.lock().unwrap().len() == 1);
        focus(windows[1]);
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(
            STOPS.lock().unwrap().len(),
            1,
            "window change while held must stop recording before key-up"
        );
        keys("keyup", &["space", "Alt_L", "Control_L"]);
        keys("keydown", &["Control_L", "Alt_L", "space"]);
        wait("second recording", || STARTS.lock().unwrap().len() == 2);
        focus(0);
        wait("focus loss stops recording", || {
            STOPS.lock().unwrap().len() == 2
        });
        keys("keyup", &["space", "Alt_L", "Control_L"]);
        focus(windows[1]);
        keys("keydown", &["Control_L", "Alt_L", "space"]);
        wait("third recording", || STARTS.lock().unwrap().len() == 3);
        keys("keyup", &["Control_L"]);
        wait("foreign modifier key-up stops recording", || {
            STOPS.lock().unwrap().len() == 3
        });
        keys("keyup", &["space", "Alt_L"]);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            STOPS.lock().unwrap().len(),
            3,
            "duplicate release sources must not stop twice"
        );
    }
}
