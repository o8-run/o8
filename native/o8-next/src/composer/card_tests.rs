use super::*;
use gpui::{Modifiers, TestAppContext, VisualTestContext};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Stdio},
};

struct Fixture {
    server: Child,
    client: Client,
}
impl Fixture {
    fn start(_: bool) -> Self {
        let mut server = Command::new("node")
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "scripts/next/dev-server.ts",
                "--composer",
                "--settings",
            ])
            .env("O8_NEXT_API_TOKEN", "fixture-composer-card")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
        let origin = lines
            .find_map(|line| {
                serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                    .as_str()
                    .map(str::to_owned)
            })
            .expect("fixture origin");
        std::thread::spawn(move || for _ in lines {});
        Self {
            server,
            client: Client::authenticated(&origin, Some("fixture-composer-card".into())).unwrap(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.server.id().to_string()])
            .status();
        let _ = self.server.wait();
    }
}
fn draw(cx: &mut VisualTestContext) {
    for _ in 0..2 {
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
    }
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    fixture: &Fixture,
) -> (gpui::Entity<Surface>, &'a mut VisualTestContext) {
    let client = fixture.client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = fixture.client.sessions().unwrap();
        s.select("thoughts-composer-first".into(), cx);
    });
    cx.run_until_parked();
    draw(cx);
    assert!(surface.read_with(cx, |s, _| s.queue_ready));
    (surface, cx)
}
fn click(selector: &'static str, cx: &mut VisualTestContext) {
    draw(cx);
    let bounds = cx.debug_bounds(selector).expect(selector);
    cx.simulate_click(bounds.center(), Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}
fn production_wire_oracle(payload: &Value) {
    use std::io::Write;
    let mut oracle = Command::new("node")
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args(["--import", "tsx", "--input-type=module", "--eval", r#"
import composer from './src/lib/orchestrator/composer-wire.ts';
const { composeComposerWireMessage } = composer;
let input = ''; for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
if (composeComposerWireMessage(payload.text, payload.routing.pickedMode).wireMessage !== payload.wireMessage) process.exit(9);
"#])
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    oracle
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(payload).unwrap())
        .unwrap();
    assert!(
        oracle.wait().unwrap().success(),
        "the persisted native queue payload must match the production composer wire"
    );
}

#[gpui::test]
fn native_composer_card_controls_persist_and_send_the_selected_routing(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    let mut previous = gpui::px(0.);
    for selector in [
        "composer-mode",
        "composer-access",
        "composer-attach",
        "composer-model",
        "composer-effort",
        "composer-microphone",
        "send",
    ] {
        let bounds = cx.debug_bounds(selector).expect(selector);
        assert!(bounds.left() >= previous, "footer order: {selector}");
        previous = bounds.right();
    }
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).placeholder, "Message Solo…");
    });
    assert!(cx.debug_bounds("composer-hint").is_none());
    click("composer-mode", cx);
    click("mode-multitask", cx);
    click("composer-access", cx);
    click("access-full", cx);
    click("composer-effort", cx);
    click("effort-high", cx);
    click("composer-model", cx);
    click("composer-model-input", cx);
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("gpt-6-astra");
    click("composer-model-save", cx);
    let defaults: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_eq!(defaults["values"]["thinkingEffort"], "high");
    assert_eq!(defaults["values"]["orchestratorModel"], "gpt-6-astra");
    surface.update_in(cx, |s, window, cx| {
        s.send_next = true;
        s.composer.read(cx).focus.focus(window);
    });
    cx.simulate_input("Selected controls");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    surface.read_with(cx, |s, cx| {
        let routing = &s.queue["items"][0]["payload"]["routing"];
        assert_eq!(routing["pickedMode"], "multitask");
        assert_eq!(routing["mode"], "fleet");
        assert_eq!(routing["permissionMode"], "full");
        assert_eq!(routing["model"], "gpt-6-astra");
        assert_eq!(routing["effort"], "high");
        assert!(
            s.queue["items"][0]["payload"]["wireMessage"]
                .as_str()
                .unwrap()
                .starts_with("[Mode: Multitask]")
        );
        assert!(s.composer.read(cx).text.is_empty());
        production_wire_oracle(&s.queue["items"][0]["payload"]);
    });
    for (mode, selector) in [("solo", "mode-solo"), ("fast", "mode-fast")] {
        click("composer-mode", cx);
        click(selector, cx);
        cx.simulate_input(mode);
        cx.simulate_keystrokes("enter");
        cx.run_until_parked();
        surface.read_with(cx, |s, _| {
            let item = s.queue["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["payload"]["text"] == mode)
                .unwrap();
            assert_eq!(item["payload"]["routing"]["pickedMode"], mode);
            production_wire_oracle(&item["payload"]);
        });
    }
}

#[gpui::test]
fn native_composer_card_restores_focus_and_keeps_each_session_choice(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    click("composer-mode", cx);
    click("mode-multitask", cx);
    surface.update_in(cx, |s, window, cx| {
        assert!(s.composer.read(cx).focus.is_focused(window))
    });
    surface.update(cx, |s, cx| s.select("thoughts-composer-second".into(), cx));
    cx.run_until_parked();
    draw(cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).placeholder, "Message Solo…")
    });
    surface.update(cx, |s, cx| s.select("thoughts-composer-first".into(), cx));
    cx.run_until_parked();
    draw(cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).placeholder, "Message Worktrees…")
    });
}

#[gpui::test]
fn native_composer_review_escape_restores_chip_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    click("composer-access", cx);
    cx.simulate_keystrokes("escape");
    surface.update_in(cx, |s, window, cx| {
        assert!(
            s.composer.read(cx).controls.focus["composer-access"].is_focused(window),
            "Escape returns to the control that opened the picker"
        );
    });
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert!(
        cx.debug_bounds("access-plan").is_some(),
        "the focused chip opens with Enter"
    );
}

#[cfg(unix)]
#[gpui::test]
fn native_composer_review_canonical_receipt_accepts_temp_directory_alias(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    let repo = surface.read_with(cx, |s, _| {
        s.sessions
            .iter()
            .find(|s| s.id == "thoughts-composer-first")
            .unwrap()
            .repo_path
            .clone()
            .unwrap()
    });
    let alias = std::env::temp_dir().join(format!("o8-composer-alias-{}", std::process::id()));
    std::os::unix::fs::symlink(&repo, &alias).unwrap();
    assert_eq!(
        fs::canonicalize(&alias).unwrap(),
        fs::canonicalize(&repo).unwrap()
    );
    surface.update_in(cx, |s, window, cx| {
        s.sessions
            .iter_mut()
            .find(|s| s.id == "thoughts-composer-first")
            .unwrap()
            .repo_path = Some(alias.to_string_lossy().into());
        s.send_next = true;
        s.composer.read(cx).focus.focus(window);
    });
    cx.simulate_input("Canonical receipt");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    surface.read_with(cx, |s, cx| {
        assert_eq!(
            fs::canonicalize(s.queue["items"][0]["repoPath"].as_str().unwrap()).unwrap(),
            fs::canonicalize(&repo).unwrap()
        );
        assert!(
            s.composer.read(cx).text.is_empty(),
            "the canonical server receipt confirms this send"
        );
    });
    fs::remove_file(alias).unwrap();
}

#[gpui::test]
fn native_composer_review_inflight_model_save_cannot_change_another_draft_or_focus(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    click("composer-model", cx);
    click("composer-model-input", cx);
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("gpt-6-astra");
    let editor = surface.read_with(cx, |s, _| s.composer.clone());
    let target = surface.clone();
    let handle = cx.update(|window, _| window.window_handle());
    let switched = Rc::new(Cell::new(false));
    let observed = switched.clone();
    let _subscription = cx.update(|_, cx| {
        cx.observe(&editor, move |editor, cx| {
            if editor.read(cx).controls.busy && !observed.replace(true) {
                handle
                    .update(cx, |_, window, cx| {
                        target.update(cx, |s, cx| {
                            s.select("thoughts-composer-second".into(), cx);
                            s.composer.read(cx).focus.focus(window);
                        })
                    })
                    .unwrap();
            }
        })
    });
    click("composer-model-save", cx);
    cx.run_until_parked();
    assert!(
        switched.get(),
        "the test must switch while the save is pending"
    );
    surface.update_in(cx, |s, window, cx| {
        assert_eq!(s.selected.as_deref(), Some("thoughts-composer-second"));
        assert_eq!(s.composer_routing(cx).unwrap()["model"], "pi");
        assert!(s.composer.read(cx).focus.is_focused(window));
    });
    surface.update(cx, |s, cx| s.select("thoughts-composer-first".into(), cx));
    cx.run_until_parked();
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer_routing(cx).unwrap()["model"], "gpt-6-astra")
    });
}

#[gpui::test]
fn native_composer_card_rejected_model_retains_route_and_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    click("composer-input", cx);
    cx.simulate_input("Keep this draft");
    click("composer-model", cx);
    click("composer-model-input", cx);
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("fixture-unsupported-model");
    click("composer-model-save", cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer_routing(cx).unwrap()["model"], "pi");
        assert_eq!(s.composer.read(cx).text, "Keep this draft");
        assert!(!s.composer.read(cx).controls.error.is_empty());
    });
}

#[gpui::test]
fn native_composer_card_controls_fit_compact_and_wide_windows(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    surface.update(cx, |s, _| {
        s.routing.as_mut().unwrap()["model"] = json!("long-model-".repeat(40));
    });
    for (width, height) in [(900., 700.), (1680., 1050.)] {
        cx.simulate_resize(gpui::size(gpui::px(width), gpui::px(height)));
        draw(cx);
        let card = cx.debug_bounds("composer-card").unwrap();
        let send = cx.debug_bounds("send").unwrap();
        assert!(send.right() <= card.right() && send.bottom() <= card.bottom());
        assert!(card.left() >= gpui::px(0.) && card.right() <= gpui::px(width));
    }
}

#[gpui::test]
fn native_composer_card_send_preserves_images_added_after_the_request(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    let sent = json!({"name":"first.png", "dataUri":"data:image/png;base64,aW1hZ2U="});
    let later = json!({"name":"second.png", "dataUri":"data:image/png;base64,bGF0ZXI="});
    surface.update_in(cx, |s, window, cx| {
        s.routing.as_mut().unwrap()["backend"] = json!("codex");
        s.send_next = true;
        s.composer
            .update(cx, |i, _| i.controls.images.push(sent.clone()));
        s.composer.read(cx).focus.focus(window);
    });
    cx.simulate_input("Images in this request");
    let observed = Rc::new(Cell::new(false));
    let changed = observed.clone();
    let late_image = later.clone();
    let _subscription = cx.update(|_, cx| {
        cx.observe(&surface, move |surface, cx| {
            if surface.read(cx).saving && !changed.replace(true) {
                surface
                    .read(cx)
                    .composer
                    .clone()
                    .update(cx, |i, _| i.controls.images.push(late_image.clone()));
            }
        })
    });
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert!(
        observed.get(),
        "the attachment must arrive while Send is pending"
    );
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.queue["items"][0]["payload"]["images"], json!([sent]));
        assert_eq!(s.composer.read(cx).controls.images, vec![later]);
    });
}
