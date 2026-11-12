//! A development driver for the real window: name a control, press it.
//!
//! Built only with the `driver` feature and in tests, never in a release.
//! With `O8_NEXT_DRIVER_SOCKET` set, the window answers one JSON request per
//! line on that unix socket. A press finds its control in the current frame
//! and lands in the same update, so it cannot hit whatever moved under an old
//! coordinate. A control that changes real state is refused unless the
//! request names it in `allow`. That guard prevents accidents; it is not a
//! security boundary, since the caller writes `allow` itself.
use gpui::{
    App, Bounds, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    Pixels, PlatformInput, ScrollDelta, ScrollWheelEvent, TouchPhase, Window, point, px,
};
use serde_json::{Value, json};

/// Words in a control's name that mark it as changing real state.
const GUARDED: [&str; 31] = [
    "accept", "approve", "archive", "close", "confirm", "delete", "discard", "dismiss", "kill",
    "logout", "merge", "off", "pick", "publish", "ready", "reject", "release", "remove", "reply",
    "reset", "respond", "revoke", "send", "settle", "ship", "snooze", "steer", "stop", "submit",
    "suppress", "unmerged",
];

/// True when a control's name says it changes real state.
pub(crate) fn guarded(selector: &str) -> bool {
    selector
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| GUARDED.contains(&word.to_ascii_lowercase().as_str()))
}

/// Answers one request against a frame drawn for it. An ordinary frame
/// reuses views that did not change and records no bounds for them, so a
/// request that read the last one would miss their controls.
pub(crate) fn answer(request: &Value, window: &mut Window, cx: &mut App) -> Value {
    settle(window, cx);
    handle(request, window, cx)
}

fn handle(request: &Value, window: &mut Window, cx: &mut App) -> Value {
    let result = match request["command"].as_str().unwrap_or_default() {
        "snapshot" => Ok(snapshot(request, window)),
        "press" => press(request, window, cx),
        "scroll" => scroll(request, window, cx),
        "key" => keys(request, window, cx),
        "type" => type_text(request, window, cx),
        other => Err(format!("unknown command {other:?}")),
    };
    match result {
        Ok(result) => json!({"ok": true, "result": result}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

fn number(value: Pixels) -> f64 {
    (f64::from(f32::from(value)) * 10.).round() / 10.
}

fn allowed(request: &Value, name: &str) -> bool {
    request["allow"]
        .as_array()
        .is_some_and(|allow| allow.iter().any(|entry| entry == name))
}

/// Every named control in the frame, sorted by name; `prefix` narrows it.
fn snapshot(request: &Value, window: &Window) -> Value {
    let prefix = request["prefix"].as_str().unwrap_or_default();
    let mut controls: Vec<_> = window
        .debug_selector_bounds()
        .into_iter()
        .filter(|(selector, _)| selector.starts_with(prefix))
        .collect();
    controls.sort_by(|a, b| a.0.cmp(&b.0));
    let viewport = window.viewport_size();
    json!({
        "viewport": {"width": number(viewport.width), "height": number(viewport.height)},
        "controls": controls.into_iter().map(|(selector, bounds)| json!({
            "selector": selector,
            "guarded": guarded(&selector),
            "x": number(bounds.origin.x),
            "y": number(bounds.origin.y),
            "width": number(bounds.size.width),
            "height": number(bounds.size.height),
        })).collect::<Vec<_>>(),
    })
}

/// The named control's bounds in this frame; it must be drawn and its centre
/// inside the window.
fn target(request: &Value, window: &Window) -> Result<(String, Bounds<Pixels>), String> {
    let selector = request["selector"]
        .as_str()
        .filter(|selector| !selector.is_empty())
        .ok_or("selector is required")?;
    let bounds = window
        .debug_selector_bounds()
        .into_iter()
        .find(|(name, _)| name == selector)
        .map(|(_, bounds)| bounds)
        .ok_or_else(|| format!("no control named {selector:?} in the current frame"))?;
    let viewport = Bounds::new(point(px(0.), px(0.)), window.viewport_size());
    if bounds.size.width <= px(0.)
        || bounds.size.height <= px(0.)
        || !viewport.contains(&bounds.center())
    {
        return Err(format!("{selector:?} is not on screen"));
    }
    Ok((selector.to_owned(), bounds))
}

/// Bounds are recorded before clipping, and only for named controls. So a
/// press is sent only when the topmost press area at the point lies inside
/// the named control: not when the control is clipped away, hidden, or under
/// something that has no name.
fn reaches(target: Bounds<Pixels>, window: &Window) -> bool {
    let slack = px(0.5);
    window
        .topmost_hitbox_bounds(target.center())
        .is_some_and(|top| {
            top.left() >= target.left() - slack
                && top.top() >= target.top() - slack
                && top.right() <= target.right() + slack
                && top.bottom() <= target.bottom() + slack
        })
}

/// Draws every view afresh, so the frame holds the bounds of every named
/// control as the window stands now, then asks the platform to show it.
pub(crate) fn settle(window: &mut Window, cx: &mut App) {
    window.refresh();
    window.draw(cx).clear();
    window.refresh();
}

fn press(request: &Value, window: &mut Window, cx: &mut App) -> Result<Value, String> {
    let (selector, bounds) = target(request, window)?;
    let position = bounds.center();
    // The press goes to whatever is on top at that point. Refuse it when the
    // target, or any other control drawn over that point, changes real state
    // and was not named.
    for (name, other) in window.debug_selector_bounds() {
        if other.contains(&position) && guarded(&name) && !allowed(request, &name) {
            return Err(if name == selector {
                format!("{name:?} changes real state; name it in \"allow\" to press it")
            } else {
                format!("{name:?} changes real state and covers that point; name it in \"allow\"")
            });
        }
    }
    if !reaches(bounds, window) {
        return Err(format!(
            "{selector:?} is not what a press there would reach: it is clipped, hidden, \
             covered, or has no press area of its own"
        ));
    }
    let modifiers = Modifiers::default();
    for event in [
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            pressed_button: None,
            modifiers,
        }),
        PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Left,
            position,
            modifiers,
            click_count: 1,
            first_mouse: false,
        }),
        PlatformInput::MouseUp(MouseUpEvent {
            button: MouseButton::Left,
            position,
            modifiers,
            click_count: 1,
        }),
    ] {
        window.dispatch_input_event(event, cx);
    }
    Ok(json!({"selector": selector, "x": number(position.x), "y": number(position.y)}))
}

/// A wheel movement over a control, in points; positive `dy` shows what is above.
fn scroll(request: &Value, window: &mut Window, cx: &mut App) -> Result<Value, String> {
    let (selector, bounds) = target(request, window)?;
    let delta = |key: &str| request[key].as_f64().unwrap_or(0.) as f32;
    let (dx, dy) = (delta("dx"), delta("dy"));
    if dx == 0. && dy == 0. {
        return Err("dx or dy is required".into());
    }
    window.dispatch_input_event(
        PlatformInput::ScrollWheel(ScrollWheelEvent {
            position: bounds.center(),
            delta: ScrollDelta::Pixels(point(px(dx), px(dy))),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
        }),
        cx,
    );
    Ok(json!({"selector": selector, "dx": dx, "dy": dy}))
}

/// The name a keystroke must be allowed under, when it can confirm, send or
/// run something: Enter, Space on a focused button, and the control keys a
/// terminal reads as a line end.
fn confirms(key: &Keystroke) -> Option<String> {
    let line_end = key.modifiers.control && matches!(key.key.as_str(), "m" | "j");
    (matches!(key.key.as_str(), "enter" | "space") || line_end)
        .then(|| format!("key:{}", if line_end { format!("ctrl-{}", key.key) } else { key.key.clone() }))
}

/// Keystrokes such as `cmd-k` or `escape`, separated by spaces. One that can
/// confirm must be named in `allow`, as `key:enter`, `key:space` or
/// `key:ctrl-m`.
fn keys(request: &Value, window: &mut Window, cx: &mut App) -> Result<Value, String> {
    let text = request["keys"].as_str().unwrap_or_default();
    let parsed = text
        .split_whitespace()
        .map(|key| Keystroke::parse(key).map_err(|error| format!("{key:?}: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    if parsed.is_empty() {
        return Err("keys is required".into());
    }
    if let Some(name) = parsed
        .iter()
        .filter_map(confirms)
        .find(|name| !allowed(request, name))
    {
        return Err(format!(
            "that key can confirm, send or run something; name {name:?} in \"allow\" to press it"
        ));
    }
    let count = parsed.len();
    for key in parsed {
        window.dispatch_keystroke(key, cx);
    }
    Ok(json!({"keys": count}))
}

/// Text given to the focused text input. It goes in as text, not as key
/// presses, so no key listener acts on a space or a letter, and it never
/// carries a line break.
fn type_text(request: &Value, window: &mut Window, cx: &mut App) -> Result<Value, String> {
    let text = request["text"].as_str().unwrap_or_default();
    if text.is_empty() {
        return Err("text is required".into());
    }
    if text.chars().any(char::is_control) {
        return Err("type takes printable text; use key for enter, tab and the rest".into());
    }
    if !window.dispatch_text_input(text, cx) {
        return Err("nothing that takes text has focus".into());
    }
    Ok(json!({"characters": text.chars().count()}))
}

#[cfg(all(feature = "driver", unix))]
pub(crate) use socket::listen;

#[cfg(all(feature = "driver", unix))]
mod socket {
    use super::{answer, settle};
    use gpui::{AnyWindowHandle, App};
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, BufReader, Read, Write},
        os::unix::{
            fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    /// A request, where its answer goes, and when it stops being wanted.
    type Job = (Value, mpsc::Sender<Value>, Instant);
    /// A request not started within this long is dropped, never run late.
    const START_WITHIN: Duration = Duration::from_secs(5);
    const ANSWER_WITHIN: Duration = Duration::from_secs(15);
    const LONGEST_LINE: u64 = 64 * 1024;
    const MOST_CLIENTS: usize = 8;
    const LARGEST_LOG: u64 = 1024 * 1024;

    /// Starts answering on `O8_NEXT_DRIVER_SOCKET`, when it is set.
    pub(crate) fn listen(window: AnyWindowHandle, cx: &mut App) {
        let Some(path) = std::env::var_os("O8_NEXT_DRIVER_SOCKET")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
        else {
            return;
        };
        let listener = match bind(&path) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("o8 next driver: {}: {error}", path.display());
                return;
            }
        };
        eprintln!("o8 next driver: listening on {}", path.display());
        let (jobs, queue) = async_channel::unbounded::<Job>();
        let log = path.with_extension("log");
        if std::fs::metadata(&log).is_ok_and(|log| log.len() > LARGEST_LOG) {
            let _ = std::fs::remove_file(&log);
        }
        let clients = Arc::new(AtomicUsize::new(0));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if clients.fetch_add(1, Ordering::SeqCst) >= MOST_CLIENTS {
                    clients.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let (jobs, log, clients) = (jobs.clone(), log.clone(), clients.clone());
                std::thread::spawn(move || {
                    serve(stream, jobs, &log);
                    clients.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        // Requests run on the window's own thread, one at a time.
        cx.spawn(async move |cx| {
            while let Ok((request, reply, deadline)) = queue.recv().await {
                if Instant::now() > deadline {
                    let _ = reply.send(json!({"ok": false, "error": "late; not run"}));
                    continue;
                }
                let answer = window
                    .update(cx, |_, window, cx| answer(&request, window, cx))
                    .unwrap_or_else(|_| json!({"ok": false, "error": "the window is closed"}));
                // A separate update, so what the request set off has run and
                // the window shows it.
                let _ = window.update(cx, |_, window, cx| settle(window, cx));
                let _ = reply.send(answer);
            }
        })
        .detach();
    }

    /// A socket only its owner can open. A stale socket is replaced; anything
    /// else at the path, or a socket another window still answers on, is left.
    /// The socket is made inside a private directory and moved into place
    /// once its mode is set, so it is never open to another account.
    fn bind(path: &Path) -> std::io::Result<UnixListener> {
        if let Ok(existing) = std::fs::symlink_metadata(path) {
            if !existing.file_type().is_socket() {
                return Err(std::io::Error::other("the path exists and is not a socket"));
            }
            if UnixStream::connect(path).is_ok() {
                return Err(std::io::Error::other("another window already answers there"));
            }
            std::fs::remove_file(path)?;
        }
        let private = path.with_extension(format!("{}.d", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&private)?;
        let made = private.join("s");
        let listener = UnixListener::bind(&made)
            .and_then(|listener| {
                std::fs::set_permissions(&made, std::fs::Permissions::from_mode(0o600))?;
                std::fs::rename(&made, path)?;
                Ok(listener)
            });
        let _ = std::fs::remove_file(&made);
        let _ = std::fs::remove_dir(&private);
        listener
    }

    fn serve(stream: UnixStream, jobs: async_channel::Sender<Job>, log: &Path) {
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        loop {
            let mut line = String::new();
            match (&mut reader).take(LONGEST_LINE).read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            if !line.ends_with('\n') && line.len() as u64 >= LONGEST_LINE {
                let _ = writeln!(writer, "{}", json!({"ok": false, "error": "the request is too long"}));
                return;
            }
            if line.trim().is_empty() {
                continue;
            }
            let (request, answer) = match serde_json::from_str::<Value>(&line) {
                Ok(request) => {
                    let (reply, answer) = mpsc::channel();
                    let job = (request.clone(), reply, Instant::now() + START_WITHIN);
                    if jobs.send_blocking(job).is_err() {
                        return;
                    }
                    let answer = answer.recv_timeout(ANSWER_WITHIN).unwrap_or_else(|_| {
                        json!({"ok": false, "error":
                            "the window did not answer; the request may still have run, \
                             so take a snapshot before trying again"})
                    });
                    (request, answer)
                }
                Err(error) => (
                    Value::Null,
                    json!({"ok": false, "error": format!("not JSON: {error}")}),
                ),
            };
            record(log, &request, &answer);
            if writeln!(writer, "{answer}").is_err() {
                return;
            }
        }
    }

    /// One line per request: when, what and whether it was done. Keys and
    /// typed text are left out, since either may be a secret.
    fn record(log: &Path, request: &Value, answer: &Value) {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let line = json!({
            "at": at,
            "command": request["command"],
            "selector": request["selector"],
            "allow": request["allow"],
            "ok": answer["ok"],
            "error": answer["error"],
        });
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(log)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

#[cfg(test)]
#[path = "driver_tests.rs"]
mod tests;
