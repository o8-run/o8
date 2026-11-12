//! A development driver for the real window: name a control, press it.
//!
//! Built only with the `driver` feature and in tests, never in a release.
//! With `O8_NEXT_DRIVER_SOCKET` set, the window answers one JSON request per
//! line on that unix socket. A press finds its control in the current frame
//! and lands in the same update, so it cannot hit whatever moved under an old
//! coordinate. A control that changes real state is refused unless the
//! request names it in `allow`.
use gpui::{
    App, Bounds, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    Pixels, PlatformInput, ScrollDelta, ScrollWheelEvent, TouchPhase, Window, point, px,
};
use serde_json::{Value, json};

/// Words in a control's name that mark it as changing real state.
const GUARDED: [&str; 22] = [
    "accept", "approve", "archive", "delete", "discard", "dismiss", "kill", "logout", "merge",
    "publish", "reject", "release", "remove", "reset", "revoke", "send", "settle", "ship", "stop",
    "submit", "suppress", "unmerged",
];

/// True when a control's name says it changes real state.
pub(crate) fn guarded(selector: &str) -> bool {
    selector
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| GUARDED.contains(&word.to_ascii_lowercase().as_str()))
}

/// Answers one request against the window's current frame.
pub(crate) fn handle(request: &Value, window: &mut Window, cx: &mut App) -> Value {
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

/// Keystrokes such as `cmd-k` or `escape`, separated by spaces. Enter sends
/// and confirms, so it must be named in `allow` as `key:enter`.
fn keys(request: &Value, window: &mut Window, cx: &mut App) -> Result<Value, String> {
    let text = request["keys"].as_str().unwrap_or_default();
    let parsed = text
        .split_whitespace()
        .map(|key| Keystroke::parse(key).map_err(|error| format!("{key:?}: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    if parsed.is_empty() {
        return Err("keys is required".into());
    }
    if parsed.iter().any(|key| key.key == "enter") && !allowed(request, "key:enter") {
        return Err("enter sends and confirms; name \"key:enter\" in \"allow\" to press it".into());
    }
    for key in parsed {
        window.dispatch_keystroke(key, cx);
    }
    Ok(json!({"keys": text}))
}

/// Text typed into whatever has focus. It never carries a line break.
fn type_text(request: &Value, window: &mut Window, cx: &mut App) -> Result<Value, String> {
    let text = request["text"].as_str().unwrap_or_default();
    if text.is_empty() {
        return Err("text is required".into());
    }
    if text.chars().any(char::is_control) {
        return Err("type takes printable text; use key for enter, tab and the rest".into());
    }
    for character in text.chars() {
        let key = if character == ' ' {
            "space".to_owned()
        } else {
            character.to_string()
        };
        window.dispatch_keystroke(
            Keystroke {
                modifiers: Modifiers::default(),
                key,
                key_char: Some(character.to_string()),
            },
            cx,
        );
    }
    Ok(json!({"characters": text.chars().count()}))
}

#[cfg(all(feature = "driver", unix))]
pub(crate) use socket::listen;

#[cfg(all(feature = "driver", unix))]
mod socket {
    use super::handle;
    use gpui::{AnyWindowHandle, App};
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::{
            fs::FileTypeExt,
            net::{UnixListener, UnixStream},
        },
        path::{Path, PathBuf},
        sync::mpsc,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    type Job = (Value, mpsc::Sender<Value>);

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
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (jobs, log) = (jobs.clone(), log.clone());
                std::thread::spawn(move || serve(stream, jobs, &log));
            }
        });
        // Requests run on the window's own thread, one at a time.
        cx.spawn(async move |cx| {
            while let Ok((request, reply)) = queue.recv().await {
                let answer = window
                    .update(cx, |_, window, cx| handle(&request, window, cx))
                    .unwrap_or_else(|_| json!({"ok": false, "error": "the window is closed"}));
                let _ = reply.send(answer);
            }
        })
        .detach();
    }

    /// A socket only its owner can open. A stale socket is replaced; anything
    /// else at the path, or a socket another window still answers on, is left.
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
        // The mask applies from the moment the socket exists, so there is no
        // instant at which another account could open it.
        // SAFETY: umask only swaps the process's file mode mask.
        let previous = unsafe { libc::umask(0o177) };
        let listener = UnixListener::bind(path);
        // SAFETY: as above; this restores the mask.
        unsafe { libc::umask(previous) };
        listener
    }

    fn serve(stream: UnixStream, jobs: async_channel::Sender<Job>, log: &Path) {
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let (request, answer) = match serde_json::from_str::<Value>(&line) {
                Ok(request) => {
                    let (reply, answer) = mpsc::channel();
                    if jobs.send_blocking((request.clone(), reply)).is_err() {
                        return;
                    }
                    let answer = answer
                        .recv_timeout(Duration::from_secs(10))
                        .unwrap_or_else(|_| {
                            json!({"ok": false, "error": "the window did not answer"})
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

    /// One line per request: when, what and whether it was done. Typed text
    /// is left out, since it may be a secret.
    fn record(log: &Path, request: &Value, answer: &Value) {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let line = json!({
            "at": at,
            "command": request["command"],
            "selector": request["selector"],
            "keys": request["keys"],
            "allow": request["allow"],
            "ok": answer["ok"],
            "error": answer["error"],
        });
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

#[cfg(test)]
#[path = "driver_tests.rs"]
mod tests;
