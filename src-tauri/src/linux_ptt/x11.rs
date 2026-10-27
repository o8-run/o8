//! Independent focus and physical-key observation for an active hold.
//! A passive shortcut grab alone does not end a hold when focus changes.

use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri_plugin_global_shortcut::{Modifiers, Shortcut};
use x11rb::connection::Connection;
use x11rb::protocol::xinput::{ConnectionExt as _, Device, EventMask as InputMask, XIEventMask};
use x11rb::protocol::xproto::{AtomEnum, ChangeWindowAttributesAux, ConnectionExt, EventMask};
use x11rb::protocol::Event;
use x11rb::reexports::x11rb_protocol::{parse_display::parse_display, xauth::get_auth};
use x11rb::rust_connection::{DefaultStream, RustConnection};

const INTERVAL: Duration = Duration::from_millis(20);
const STALLED: u64 = 300;
type Ready = mpsc::Sender<Result<(), String>>;
type Socket = Arc<Mutex<Option<OwnedFd>>>;

pub(super) struct Monitor {
    sender: mpsc::Sender<(u64, Ready)>,
    failed: Arc<AtomicBool>,
    token: Arc<AtomicU64>,
}

impl Monitor {
    pub(super) fn new(
        shortcut: Shortcut,
        is_active: impl Fn(u64) -> bool + Send + 'static,
        cancel: impl Fn(u64) + Send + Sync + 'static,
    ) -> Self {
        let (sender, receiver) = mpsc::channel::<(u64, Ready)>();
        let failed = Arc::new(AtomicBool::new(false));
        let token = Arc::new(AtomicU64::new(0));
        let pending = Arc::new(AtomicBool::new(true));
        let since = Arc::new(AtomicU64::new(0));
        let done = Arc::new(AtomicBool::new(false));
        let socket: Socket = Arc::new(Mutex::new(None));
        let cancel = Arc::new(cancel);
        let epoch = Instant::now();
        let result = Self {
            sender,
            failed: failed.clone(),
            token: token.clone(),
        };

        // Bound a stalled X server as well as ordinary focus/key changes. A
        // duplicate socket descriptor lets shutdown unblock a pending reply
        // without racing descriptor reuse. No microphone starts without ready.
        let watch_failed = failed.clone();
        let watch_pending = pending.clone();
        let watch_since = since.clone();
        let watch_done = done.clone();
        let watch_socket = socket.clone();
        let watch_cancel = cancel.clone();
        let worker_token = token.clone();
        std::thread::spawn(move || {
            while !watch_done.load(Ordering::SeqCst) {
                std::thread::sleep(INTERVAL);
                if watch_pending.load(Ordering::SeqCst)
                    && (epoch.elapsed().as_millis() as u64)
                        .saturating_sub(watch_since.load(Ordering::SeqCst))
                        > STALLED
                {
                    watch_failed.store(true, Ordering::SeqCst);
                    watch_cancel(token.load(Ordering::SeqCst));
                    if let Some(fd) = watch_socket.lock().unwrap().as_ref() {
                        // SAFETY: this owned descriptor remains alive for the call.
                        unsafe {
                            libc::shutdown(fd.as_raw_fd(), libc::SHUT_RDWR);
                        }
                    }
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            let run = || -> Result<(), String> {
                let (connection, screen) = connect(&socket, &failed)?;
                let keys = Keys::new(&connection, shortcut)?;
                connection
                    .xinput_xi_query_version(2, 1)
                    .map_err(|e| e.to_string())?
                    .reply()
                    .map_err(|e| e.to_string())?;
                let root = connection.setup().roots[screen].root;
                let atom = connection
                    .intern_atom(false, b"_NET_ACTIVE_WINDOW")
                    .map_err(|e| e.to_string())?
                    .reply()
                    .map_err(|e| e.to_string())?
                    .atom;
                connection
                    .change_window_attributes(
                        root,
                        &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
                    )
                    .map_err(|e| e.to_string())?
                    .check()
                    .map_err(|e| e.to_string())?;
                connection
                    .xinput_xi_select_events(
                        root,
                        &[InputMask {
                            deviceid: Device::ALL_MASTER.into(),
                            mask: vec![XIEventMask::RAW_KEY_RELEASE],
                        }],
                    )
                    .map_err(|e| e.to_string())?
                    .check()
                    .map_err(|e| e.to_string())?;
                pending.store(false, Ordering::SeqCst);
                let mut watching = None;
                loop {
                    let request = match receiver.recv_timeout(INTERVAL) {
                        Ok(request) => Some(request),
                        Err(mpsc::RecvTimeoutError::Timeout) => None,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                    };
                    if let Some((token, ready)) = request {
                        if failed.load(Ordering::SeqCst) || !is_active(token) {
                            let _ = ready.send(Err("hold ended".into()));
                            continue;
                        }
                        since.store(epoch.elapsed().as_millis() as u64, Ordering::SeqCst);
                        pending.store(true, Ordering::SeqCst);
                        if let Some((_, (window, _))) = watching.take() {
                            unwatch(&connection, window)?;
                        }
                        // Previous holds' queued releases cannot cancel this hold.
                        while connection
                            .poll_for_event()
                            .map_err(|e| e.to_string())?
                            .is_some()
                        {}
                        let initial = snapshot(&connection, &keys, root, atom);
                        match initial {
                            Ok(Some(focus)) if !failed.load(Ordering::SeqCst) => {
                                connection
                                    .change_window_attributes(
                                        focus.0,
                                        &ChangeWindowAttributesAux::new()
                                            .event_mask(EventMask::FOCUS_CHANGE),
                                    )
                                    .map_err(|e| e.to_string())?
                                    .check()
                                    .map_err(|e| e.to_string())?;
                                // The subscription reply is a server ordering barrier.
                                // Discard older holds' events, then revalidate focus/keys.
                                while connection
                                    .poll_for_event()
                                    .map_err(|e| e.to_string())?
                                    .is_some()
                                {}
                                if snapshot(&connection, &keys, root, atom)? == Some(focus)
                                    && is_active(token)
                                {
                                    watching = Some((token, focus));
                                    let _ = ready.send(Ok(()));
                                } else {
                                    unwatch(&connection, focus.0)?;
                                    cancel(token);
                                    let _ = ready.send(Err("hold changed while arming".into()));
                                }
                            }
                            _ => {
                                cancel(token);
                                let _ = ready.send(Err("focus or held keys unavailable".into()));
                            }
                        }
                        pending.store(false, Ordering::SeqCst);
                    }
                    if let Some((token, initial)) = watching {
                        if !is_active(token) {
                            since.store(epoch.elapsed().as_millis() as u64, Ordering::SeqCst);
                            pending.store(true, Ordering::SeqCst);
                            unwatch(&connection, initial.0)?;
                            pending.store(false, Ordering::SeqCst);
                            watching = None;
                            continue;
                        }
                        since.store(epoch.elapsed().as_millis() as u64, Ordering::SeqCst);
                        pending.store(true, Ordering::SeqCst);
                        let mut released = false;
                        while let Some(event) =
                            connection.poll_for_event().map_err(|e| e.to_string())?
                        {
                            released |= match event {
                                Event::FocusOut(event) => event.event == initial.0,
                                Event::PropertyNotify(event) => {
                                    event.window == root && event.atom == atom
                                }
                                Event::XinputRawKeyRelease(event) => keys.contains(event.detail),
                                _ => false,
                            };
                        }
                        let current = snapshot(&connection, &keys, root, atom);
                        if released
                            || failed.load(Ordering::SeqCst)
                            || current.ok().flatten() != Some(initial)
                        {
                            cancel(token);
                            unwatch(&connection, initial.0)?;
                            watching = None;
                        }
                        pending.store(false, Ordering::SeqCst);
                    }
                    if watching.is_none() {
                        // Raw releases arrive even when no hold is active. Keep
                        // the socket drained instead of retaining idle typing.
                        since.store(epoch.elapsed().as_millis() as u64, Ordering::SeqCst);
                        pending.store(true, Ordering::SeqCst);
                        while connection
                            .poll_for_event()
                            .map_err(|e| e.to_string())?
                            .is_some()
                        {}
                        pending.store(false, Ordering::SeqCst);
                    }
                    if failed.load(Ordering::SeqCst) {
                        return Err("X11 monitor stalled".into());
                    }
                }
            };
            if let Err(error) = run() {
                log::warn!("[ptt] X11 hold monitor unavailable: {error}");
            }
            failed.store(true, Ordering::SeqCst);
            // Any transport error ends the active hold, including errors at boot.
            cancel(worker_token.load(Ordering::SeqCst));
            done.store(true, Ordering::SeqCst);
        });
        result
    }

    pub(super) fn watch(&self, token: u64) -> mpsc::Receiver<Result<(), String>> {
        let (sender, receiver) = mpsc::channel();
        self.token.store(token, Ordering::SeqCst);
        if self.failed.load(Ordering::SeqCst) {
            let _ = sender.send(Err("X11 monitor unavailable".into()));
        } else if let Err(error) = self.sender.send((token, sender)) {
            let _ = error.0 .1.send(Err("X11 monitor disconnected".into()));
        }
        receiver
    }
}

// Publish the socket before waiting for authentication/setup replies, so the
// watchdog also covers an accepted connection whose server stops answering.
fn connect(socket: &Socket, failed: &AtomicBool) -> Result<(RustConnection, usize), String> {
    let display = parse_display(None).map_err(|e| e.to_string())?;
    let screen = display.screen as usize;
    let mut last_error = "no X11 address".to_string();
    for address in display.connect_instruction() {
        match DefaultStream::connect(&address) {
            Ok((stream, (family, address))) => {
                *socket.lock().unwrap() = Some(
                    stream
                        .as_fd()
                        .try_clone_to_owned()
                        .map_err(|e| e.to_string())?,
                );
                if failed.load(Ordering::SeqCst) {
                    return Err("X11 monitor timed out".into());
                }
                let (name, data) = get_auth(family, &address, display.display)
                    .unwrap_or(None)
                    .unwrap_or_default();
                return RustConnection::connect_to_stream_with_auth_info(
                    stream, screen, name, data,
                )
                .map(|connection| (connection, screen))
                .map_err(|e| e.to_string());
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(last_error)
}

fn unwatch(connection: &RustConnection, window: u32) -> Result<(), String> {
    // A destroyed former focus window may return BadWindow; it no longer
    // needs a subscription. Transport failures are caught by the next poll.
    let _ = connection
        .change_window_attributes(
            window,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::NO_EVENT),
        )
        .map_err(|e| e.to_string())?
        .check();
    Ok(())
}

struct Keys {
    main: Vec<u8>,
    modifiers: Vec<Vec<u8>>,
}

impl Keys {
    fn contains(&self, code: u32) -> bool {
        u8::try_from(code).is_ok_and(|code| {
            self.main.contains(&code) || self.modifiers.iter().any(|keys| keys.contains(&code))
        })
    }

    fn new(connection: &RustConnection, shortcut: Shortcut) -> Result<Self, String> {
        let symbol =
            keysym(&format!("{:?}", shortcut.key)).ok_or("unsupported push-to-talk key")?;
        let setup = connection.setup();
        let first = setup.min_keycode;
        let count = setup.max_keycode - first + 1;
        let mapping = connection
            .get_keyboard_mapping(first, count)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        let main = mapping
            .keysyms
            .chunks(mapping.keysyms_per_keycode as usize)
            .enumerate()
            .filter(|(_, symbols)| symbols.contains(&symbol))
            .map(|(index, _)| first + index as u8)
            .collect::<Vec<_>>();
        if main.is_empty() {
            return Err("push-to-talk key not mapped".into());
        }
        let mapping = connection
            .get_modifier_mapping()
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        let width = mapping.keycodes.len() / 8;
        let modifiers = [
            (Modifiers::SHIFT, 0),
            (Modifiers::CONTROL, 2),
            (Modifiers::ALT, 3),
            (Modifiers::SUPER | Modifiers::META, 6),
        ]
        .into_iter()
        .filter(|(mask, _)| shortcut.mods.intersects(*mask))
        .map(|(_, index)| {
            mapping.keycodes[index * width..(index + 1) * width]
                .iter()
                .copied()
                .filter(|key| *key != 0)
                .collect()
        })
        .collect();
        Ok(Self { main, modifiers })
    }
}

fn snapshot(
    connection: &RustConnection,
    keys: &Keys,
    root: u32,
    atom: u32,
) -> Result<Option<(u32, u32)>, String> {
    let focus = connection
        .get_input_focus()
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .focus;
    let active = connection
        .get_property(false, root, atom, AtomEnum::WINDOW, 0, 1)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .value32()
        .and_then(|mut values| values.next())
        .unwrap_or(0);
    let map = connection
        .query_keymap()
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .keys;
    let down = |codes: &[u8]| {
        codes
            .iter()
            .any(|code| map[*code as usize / 8] & (1 << (*code % 8)) != 0)
    };
    Ok(
        (focus > 1 && down(&keys.main) && keys.modifiers.iter().all(|codes| down(codes)))
            .then_some((focus, active)),
    )
}

fn keysym(code: &str) -> Option<u32> {
    if code.len() == 4 && code.starts_with("Key") {
        return Some(code.as_bytes()[3] as u32);
    }
    if code.len() == 6 && code.starts_with("Digit") {
        return Some(code.as_bytes()[5] as u32);
    }
    if let Some(number) = code
        .strip_prefix('F')
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| (1..=24).contains(n))
    {
        return Some(0xffbd + number);
    }
    if code.len() == 7 && code.starts_with("Numpad") && code.as_bytes()[6].is_ascii_digit() {
        return Some(0xffb0 + (code.as_bytes()[6] - b'0') as u32);
    }
    Some(match code {
        "Space" => 0x20,
        "Tab" => 0xff09,
        "Enter" => 0xff0d,
        "Escape" => 0xff1b,
        "Backspace" => 0xff08,
        "Delete" => 0xffff,
        "Home" => 0xff50,
        "End" => 0xff57,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "Insert" => 0xff63,
        "Minus" => 0x2d,
        "Equal" => 0x3d,
        "BracketLeft" => 0x5b,
        "BracketRight" => 0x5d,
        "Backslash" => 0x5c,
        "Semicolon" => 0x3b,
        "Quote" => 0x0ad0,
        "Backquote" => 0x60,
        "Comma" => 0x2c,
        "Period" => 0x2e,
        "Slash" => 0x2f,
        "CapsLock" => 0xffe5,
        "PrintScreen" => 0xff61,
        "ScrollLock" => 0xff14,
        "Pause" => 0xff13,
        // Match the shortcut backend's existing NumLock alias.
        "NumLock" => 0xffbe,
        "NumpadAdd" => 0xffab,
        "NumpadDecimal" => 0xffae,
        "NumpadDivide" => 0xffaf,
        "NumpadMultiply" => 0xffaa,
        "NumpadSubtract" => 0xffad,
        "AudioVolumeDown" => 0x1008ff11,
        "AudioVolumeMute" => 0x1008ff12,
        "AudioVolumeUp" => 0x1008ff13,
        "MediaPlay" => 0x1008ff14,
        "MediaPause" => 0x1008ff31,
        "MediaStop" => 0x1008ff15,
        "MediaTrackNext" => 0x1008ff17,
        "MediaTrackPrevious" => 0x1008ff16,
        _ => return None,
    })
}
