// Readiness for launcher-owned app updates. Agent tools keep their own controls.
use super::*;
use gpui::StatefulInteractiveElement;
use serde_json::Value;
use std::{path::Path, time::Instant};

struct LauncherUpdate;
register_shell_feature!(LauncherUpdate);
#[derive(Default)]
struct State {
    classic: bool,
    checked: Option<Instant>,
    reading: bool,
    status: String,
    notified: Option<String>,
    toast: Option<toasts::ToastId>,
    applying: bool,
}
impl ShellFeature for LauncherUpdate {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 69,
            run: |s, _, _, cx| poll(s, cx),
        }]
    }
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Content,
            order: 79,
            render: |s, _, _, cx| {
                let state = s.features.get::<State>();
                (matches!(state.status.as_str(), "staged" | "ready")).then(|| {
                    div()
                        .id("launcher-update-hint")
                        .debug_selector(|| "launcher-update-hint".into())
                        .absolute()
                        .bottom(px(12.))
                        .right(px(16.))
                        .px(px(7.))
                        .py(px(3.))
                        .rounded(px(6.))
                        .bg(crate::theme::popover_background())
                        .focusable()
                        .text_size(px(11.))
                        .text_color(theme().text_secondary)
                        .child(if state.classic {
                            "Update ready · Restart to update"
                        } else {
                            "Update installed · Restart to update"
                        })
                        .cursor_pointer()
                        .hover(|v| v.bg(theme().hover))
                        .active(|v| v.bg(theme().selection))
                        .focus(|v| v.bg(theme().hover))
                        .on_key_down(cx.listener(|s, event: &KeyDownEvent, w, cx| {
                            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                cx.stop_propagation();
                                apply(s, w, cx);
                            }
                        }))
                        .on_click(cx.listener(|s, _, w, cx| apply(s, w, cx)))
                        .into_any_element()
                })
            },
        }]
    }
}
#[cfg(unix)]
fn request(data: &Path, op: &str) -> Result<Value, String> {
    use std::io::{Read, Write};
    let mut peer = std::os::unix::net::UnixStream::connect(data.join("launcher.sock"))
        .map_err(|_| "Updater unavailable")?;
    peer.set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "Updater unavailable")?;
    peer.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "Updater unavailable")?;
    peer.write_all(serde_json::json!({"op":op}).to_string().as_bytes())
        .map_err(|_| "Updater unavailable")?;
    peer.shutdown(std::net::Shutdown::Write)
        .map_err(|_| "Updater unavailable")?;
    let mut bytes = Vec::new();
    peer.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Updater unavailable")?;
    if bytes.len() > 65536 {
        return Err("Invalid updater response".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid updater response".into())
}
#[cfg(not(unix))]
fn request(_: &Path, _: &str) -> Result<Value, String> {
    Err("Updater unavailable".into())
}

fn poll(s: &mut Shell, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.reading
        || state
            .checked
            .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
    {
        return;
    }
    state.checked = Some(Instant::now());
    state.reading = true;
    let data = s.file.parent().unwrap_or(Path::new("")).to_path_buf();
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        match request(&data, "update-status") {
            Ok(body) => Ok((false, body)),
            Err(_) => client
                .get::<Value>("/api/panel/update/apply", &[])
                .map(|body| (true, body))
                .map_err(|error| error.to_string()),
        }
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |s, cx| {
            s.features.get::<State>().reading = false;
            if let Ok((classic, body)) = result {
                s.features.get::<State>().classic = classic;
                let body = if classic {
                    let held = &body["state"]["heldUpdate"];
                    let attempt = &body["state"]["autoApply"];
                    let phase = if attempt["version"] == held["version"] {
                        attempt["phase"].as_str().unwrap_or("")
                    } else { "" };
                    let failed = phase == "failed";
                    serde_json::json!({"state": if failed { "failed" } else if matches!(phase, "installing" | "restarting") { "installing" } else { held["phase"].as_str().unwrap_or("") },
                        "available":{"version":held["version"]},
                        "error":if failed { &body["state"]["autoApply"]["error"] } else { &held["error"] }})
                } else { body };
                received(s, body, cx);
            }
        });
    })
    .detach();
}
fn received(s: &mut Shell, body: Value, cx: &mut Context<Shell>) {
    let status = body["state"].as_str().unwrap_or("").to_owned();
    let version = body["available"]["version"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let state = s.features.get::<State>();
    state.status = status.clone();
    let key = format!("{status}:{version}:{}", body["error"]);
    if matches!(status.as_str(), "staged" | "ready" | "failed")
        && state.notified.as_ref() != Some(&key)
    {
        state.notified = Some(key);
        if let Some(id) = state.toast.take() {
            toasts::dismiss(id, cx);
        }
        let target = cx.weak_entity();
        let ready = status == "staged" || status == "ready";
        let classic = state.classic;
        let id = toasts::show(
            if ready {
                toasts::Kind::Success
            } else {
                toasts::Kind::Error {
                    detail: body["error"]
                        .as_str()
                        .unwrap_or("Update failed")
                        .to_owned()
                        .into(),
                }
            },
            if ready {
                if classic {
                    "Update ready"
                } else {
                    "Update installed"
                }
            } else {
                "Update failed"
            },
            vec![toasts::Action::new(
                if ready { "Relaunch Now" } else { "Retry" },
                move |w, cx| {
                    let _ = target.update(cx, |s, cx| apply(s, w, cx));
                },
            )],
            None,
            cx,
        );
        s.features.get::<State>().toast = Some(id);
    }
    cx.notify();
}
fn apply(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if s.features.get::<State>().applying {
        return;
    }
    s.features.get::<State>().applying = true;
    let saved = super::window_state::flush_for_restart(s, window, cx);
    let drafts = crate::composer::flush_drafts(cx);
    let classic = s.features.get::<State>().classic;
    let client = s.client.clone();
    let data = s.file.parent().unwrap_or(Path::new("")).to_path_buf();
    let task = cx.background_executor().spawn(async move {
        saved
            .recv()
            .await
            .map_err(|_| "Window state writer unavailable")??;
        for draft in drafts {
            draft.await?;
        }
        if classic {
            let body = serde_json::json!({});
            let url = client
                .url("/api/panel/update/apply")
                .map_err(|error| error.to_string())?;
            match client
                .request("POST", &url)
                .timeout(Duration::from_secs(40))
                .send_json(body)
            {
                Ok(response) | Err(ureq::Error::Status(_, response)) => {
                    crate::client::Client::read::<Value>(response)
                }
                Err(error) => Err(error.to_string()),
            }
        } else {
            request(&data, "update-apply")
        }
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |s, cx| {
            s.features.get::<State>().applying = false;
            s.features.get::<State>().notified = None;
            match result {
                Ok(body) if body["ok"] == true => {
                    s.features.get::<State>().status = "installing".into();
                    toasts::show(
                        toasts::Kind::Info,
                        "Installing update",
                        vec![],
                        Some(Duration::from_secs(2)),
                        cx,
                    );
                }
                Ok(body) => {
                    let error = body["error"]["message"]
                        .as_str()
                        .or_else(|| body["error"].as_str())
                        .unwrap_or("Update could not be applied");
                    received(s, serde_json::json!({"state":"failed","error":error}), cx)
                }
                Err(error) => received(s, serde_json::json!({"state":"failed","error":error}), cx),
            }
            cx.notify();
        });
    })
    .detach();
}

#[cfg(all(test, unix))]
#[gpui::test]
fn launcher_status_reaches_toast_and_dismiss_keeps_hint(cx: &mut gpui::TestAppContext) {
    use crate::shell::test_support::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;

    // macOS's default temp directory can exceed sockaddr_un.sun_path.
    // Keep this private directory short and remove it even on assertion failure.
    struct SocketDir(std::path::PathBuf);
    impl Drop for SocketDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let name = scratch_path("o8-u");
    let data = SocketDir(Path::new("/tmp").join(name.file_name().unwrap()));
    std::fs::create_dir(&data.0).unwrap();
    let file = data.0.join("shell.json");
    let path = data.0.join("launcher.sock");
    let fixture = Fixture::new();

    fn serve(
        socket: UnixListener,
        op: &'static str,
        file: Option<std::path::PathBuf>,
    ) -> std::thread::JoinHandle<()> {
        socket.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut peer = loop {
                match socket.accept() {
                    Ok((peer, _)) => break peer,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "launcher fixture timed out accepting {op}"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("launcher fixture accept {op}: {error}"),
                }
            };
            peer.set_nonblocking(false).unwrap();
            let mut bytes = Vec::new();
            loop {
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .expect("launcher fixture request deadline exceeded");
                peer.set_read_timeout(Some(remaining)).unwrap();
                let mut chunk = [0; 1024];
                let count = peer
                    .read(&mut chunk)
                    .expect("launcher fixture request must reach EOF before deadline");
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
                assert!(bytes.len() <= 65536, "launcher fixture request too large");
            }
            let command: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(command["op"], op);
            if let Some(file) = file {
                assert!(
                    crate::shell_state::State::load(&file).is_ok(),
                    "layout committed before apply"
                );
            }
            peer.set_write_timeout(Some(
                deadline
                    .checked_duration_since(Instant::now())
                    .expect("launcher fixture response deadline exceeded"),
            ))
            .unwrap();
            peer.write_all(br#"{"ok":true,"state":"staged","available":{"version":"2.0.0"}}"#)
                .unwrap();
        })
    }
    let server = serve(UnixListener::bind(&path).unwrap(), "update-status", None);
    let (shell, mut v) = open_past_setup(
        fixture.client.clone(),
        file.clone(),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut v);
    // The production timer is virtual in GPUI tests. Drive the real tick
    // dispatch explicitly, as the other shell feature tests do.
    v.update(|window, cx| shell.update(cx, |s, cx| s.tick(false, window, cx)));
    let deadline = Instant::now() + Duration::from_secs(7);
    loop {
        v.run_until_parked();
        if shell.read_with(&v, |s, _| {
            s.features
                .read::<State>()
                .is_some_and(|state| state.status == "staged")
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "launcher status must reach native notice before deadline (server finished: {})",
            server.is_finished()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    server.join().unwrap();
    draw(&mut v);
    assert!(v.debug_bounds("launcher-update-hint").is_some());
    let id = shell.update(&mut v, |s, cx| {
        assert!(
            toasts::texts(cx)
                .iter()
                .any(|text| text == "Update installed")
        );
        s.features.get::<State>().toast.unwrap()
    });
    shell.update(&mut v, |_, cx| toasts::dismiss(id, cx));
    v.cx.executor().advance_clock(Duration::from_millis(500));
    v.run_until_parked();
    draw(&mut v);
    assert!(v.debug_bounds("launcher-update-hint").is_some());
    assert!(
        v.debug_bounds(Box::leak(format!("toast-{id}").into_boxed_str()))
            .is_none()
    );
    std::fs::remove_file(&path).unwrap();
    let applied = serve(
        UnixListener::bind(&path).unwrap(),
        "update-apply",
        Some(file),
    );
    let hint = v.debug_bounds("launcher-update-hint").unwrap();
    v.simulate_click(hint.center(), gpui::Modifiers::default());
    let deadline = Instant::now() + Duration::from_secs(7);
    while !applied.is_finished() {
        v.run_until_parked();
        assert!(
            Instant::now() < deadline,
            "hint click must reach launcher after layout flush before deadline"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    applied.join().unwrap();
}

pub(super) fn owns_notice(s: &Shell) -> bool {
    s.features.read::<State>().is_some_and(|state| {
        matches!(
            state.status.as_str(),
            "available" | "downloading" | "ready" | "staged" | "failed" | "installing"
        )
    })
}

#[cfg(test)]
#[gpui::test]
fn classic_ready_uses_shared_notice_and_apply_waits_for_drafts(cx: &mut gpui::TestAppContext) {
    use crate::settings::test_peer::Peer;
    use crate::shell::test_support::*;
    let peer = Peer::new();
    peer.reply(
        "GET",
        "/api/panel/update/apply",
        200,
        serde_json::json!({"ok":true,"state":{"heldUpdate":{"phase":"ready","version":"2.0.0"}}}),
    );
    peer.reply(
        "POST",
        "/api/panel/update/apply",
        202,
        serde_json::json!({"ok":true}),
    );
    let file = scratch_path("held-layout");
    let draft_path = scratch_path("held-draft");
    let (shell, mut v) = open_past_setup(
        peer.client.clone(),
        file.clone(),
        crate::shell_state::State::default(),
        cx,
    );
    // Use a live composer whose debounce has not elapsed.
    let editor = v.update(|_, cx| cx.new(crate::composer::Composer::new));
    editor.update(&mut v, |editor, cx| {
        editor.persist_draft = true;
        editor.controls.prompt.store = Some(draft_path.clone());
        editor.set_text("unsent before relaunch", cx);
    });
    v.update(|window, cx| shell.update(cx, |s, cx| s.tick(false, window, cx)));
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        v.run_until_parked();
        if shell.read_with(&v, |s, _| {
            s.features
                .read::<State>()
                .is_some_and(|s| s.status == "ready")
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "classic status must reach notice"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    draw(&mut v);
    shell.update(&mut v, |_, cx| {
        assert!(toasts::texts(cx).iter().any(|text| text == "Update ready"))
    });
    let hint = v.debug_bounds("launcher-update-hint").unwrap();
    assert!(v.debug_bounds("rail-update").is_none(), "the shared notice replaces the old app prompt");
    v.simulate_click(hint.center(), gpui::Modifiers::default());
    let deadline = Instant::now() + Duration::from_secs(8);
    while !peer
        .calls()
        .iter()
        .any(|(method, path, _)| method == "POST" && path == "/api/panel/update/apply")
    {
        v.run_until_parked();
        assert!(
            Instant::now() < deadline,
            "apply must follow persistence barrier"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(crate::shell_state::State::load(&file).is_ok());
    assert_eq!(
        crate::composer::mode_store::load_draft(Some(&draft_path))
            .unwrap()
            .text,
        "unsent before relaunch"
    );
    let _ = std::fs::remove_file(file);
    let _ = std::fs::remove_file(draft_path.with_extension("draft.json"));
}
