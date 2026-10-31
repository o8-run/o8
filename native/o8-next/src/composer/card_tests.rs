use super::*;
#[path = "context_card_tests.rs"]
mod context_tests;
mod image_tests;
#[path = "prompt_acceptance_tests.rs"]
mod prompt_acceptance_tests;
#[path = "prompt_persistence_tests.rs"]
mod prompt_persistence_tests;
#[path = "prompt_tests.rs"]
mod prompt_tests;
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
        Self::with_loaded(false)
    }
    fn with_loaded(loaded: bool) -> Self {
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
                "--composer-controls",
            ])
            .args(if loaded {
                vec!["--composer-loaded"]
            } else {
                vec![]
            })
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
fn native_composer_idle_card_avoids_viewport_path_targets(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (_surface, cx) = open(cx, &fixture);
    for (width, height) in [(900., 700.), (1440., 1024.)] {
        cx.simulate_resize(gpui::size(px(width), px(height)));
        draw(cx);
        assert!(cx.debug_bounds("composer-microphone").is_some());
        assert_eq!(
            cx.debug_path_count(),
            0,
            "an idle composer must not activate viewport-sized path/MSAA targets"
        );
        cx.deactivate_window();
        draw(cx);
        assert_eq!(
            cx.debug_path_count(),
            0,
            "blur must retain the bounded icon"
        );
    }
}

#[gpui::test]
fn native_composer_card_controls_persist_and_send_the_selected_routing(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    // The Thinking chip shows only for leads with effort stops, as in classic.
    surface.update(cx, |s, _| {
        s.routing.as_mut().unwrap()["backend"] = json!("codex");
    });
    draw(cx);
    let mut previous = gpui::px(0.);
    for selector in [
        "composer-mode",
        "composer-attach",
        "composer-model",
        "composer-effort",
        // Empty composer: the primary button is the dictation mic.
        "composer-microphone",
    ] {
        let bounds = cx.debug_bounds(selector).expect(selector);
        assert!(bounds.left() >= previous, "footer order: {selector}");
        previous = bounds.right();
    }
    // The fixture's chat is mid-turn, so the composer offers Steer; the
    // checkout wording shows once nothing is steerable.
    surface.update(cx, |s, cx| {
        s.queue["canSteer"] = json!(false);
        cx.notify();
    });
    draw(cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(
            s.composer.read(cx).placeholder,
            "Ask anything · workers share this checkout"
        );
    });
    assert!(cx.debug_bounds("composer-hint").is_none());
    click("composer-mode", cx);
    click("mode-multitask", cx);
    click("composer-attach", cx);
    click("attach-permission", cx);
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
    for (mode, selector) in [("fast", "mode-fast")] {
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

/// Classic offers only Shared and Worktrees. A chat saved on Solo (or with no
/// saved mode) reads and sends Shared, so it never routes into Solo's private
/// Codex home (#5165).
#[gpui::test]
fn native_composer_modes_match_classic_and_saved_solo_sends_shared(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    click("composer-mode", cx);
    assert!(
        cx.debug_bounds("mode-solo").is_none(),
        "classic has no Solo choice"
    );
    assert!(cx.debug_bounds("mode-fast").is_some());
    assert!(cx.debug_bounds("mode-multitask").is_some());
    cx.simulate_keystrokes("escape");
    surface.update(cx, |s, cx| {
        s.composer.update(cx, |i, _| {
            i.controls.overrides["pickedMode"] = json!("solo");
            i.controls.overrides["mode"] = json!("single");
        });
        s.queue["canSteer"] = json!(false);
        cx.notify();
    });
    draw(cx);
    surface.read_with(cx, |s, cx| {
        let routing = s.composer_routing(cx).unwrap();
        assert_eq!(routing["pickedMode"], "fast");
        assert_eq!(routing["mode"], "fleet");
        assert_eq!(
            s.composer.read(cx).placeholder,
            "Ask anything · workers share this checkout"
        );
    });
    surface.update_in(cx, |s, window, cx| {
        s.queue["canSteer"] = json!(true);
        s.send_next = true;
        s.composer.read(cx).focus.focus(window);
    });
    cx.simulate_input("Saved solo chat");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    surface.read_with(cx, |s, _| {
        let item = s.queue["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["payload"]["text"] == "Saved solo chat")
            .unwrap();
        assert_eq!(item["payload"]["routing"]["pickedMode"], "fast");
        assert_eq!(item["payload"]["routing"]["mode"], "fleet");
        production_wire_oracle(&item["payload"]);
    });
}

include!("lead_picker_tests.rs");

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
    // The fixture's chat is mid-turn, so the composer offers Steer; the
    // checkout wording shows once nothing is steerable.
    surface.update(cx, |s, cx| {
        s.queue["canSteer"] = json!(false);
        cx.notify();
    });
    draw(cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(
            s.composer.read(cx).placeholder,
            "Ask anything · workers share this checkout"
        )
    });
    surface.update(cx, |s, cx| s.select("thoughts-composer-first".into(), cx));
    cx.run_until_parked();
    draw(cx);
    // The fixture's chat is mid-turn, so the composer offers Steer; the
    // checkout wording shows once nothing is steerable.
    surface.update(cx, |s, cx| {
        s.queue["canSteer"] = json!(false);
        cx.notify();
    });
    draw(cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(
            s.composer.read(cx).placeholder,
            "Ask anything · workers use isolated worktrees"
        )
    });
}

#[gpui::test]
fn native_composer_review_escape_restores_chip_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    click("composer-attach", cx);
    cx.simulate_keystrokes("escape");
    surface.update_in(cx, |s, window, cx| {
        assert!(
            s.composer.read(cx).controls.focus["composer-attach"].is_focused(window),
            "Escape returns to the control that opened the picker"
        );
    });
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert!(
        cx.debug_bounds("attach-permission").is_some(),
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
        // Empty composer: the round primary button is the mic.
        let send = cx.debug_bounds("composer-microphone").unwrap();
        assert!(send.right() <= card.right() && send.bottom() <= card.bottom());
        assert!(card.left() >= gpui::px(0.) && card.right() <= gpui::px(width));
    }
}

#[gpui::test]
fn native_composer_review_image_only_send_persists_through_real_route(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    let image = json!({"name":"pixel.png", "dataUri":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpAAAAABJRU5ErkJggg=="});
    let session = surface.read_with(cx, |s, _| {
        s.sessions
            .iter()
            .find(|s| s.id == "thoughts-composer-first")
            .unwrap()
            .clone()
    });
    let mut sent_ids = BTreeSet::<String>::new();
    // First prove this exact attachment is accepted with text. Subsequent sends
    // use the same real button/client/POST path, followed by a fresh queue GET.
    for (index, draft) in ["Image control", "", "   "].into_iter().enumerate() {
        surface.update_in(cx, |s, window, cx| {
            s.routing.as_mut().unwrap()["backend"] = json!("codex");
            s.send_next = true;
            s.composer.update(cx, |i, cx| {
                i.controls.images.push(image.clone());
                cx.notify();
            });
            s.composer.read(cx).focus.focus(window);
            cx.notify();
        });
        cx.simulate_input(draft);
        if index == 2 {
            cx.simulate_keystrokes("enter");
            cx.run_until_parked();
        } else {
            click("send", cx);
        }
        let queue = fixture.client.queue(&session).unwrap();
        let items = queue["items"].as_array().unwrap();
        assert_eq!(
            items.len(),
            index + 1,
            "image-only Send must persist an attachment-only queue item, just like image plus text"
        );
        let expected = if draft.trim().is_empty() {
            "[Image attached]"
        } else {
            draft
        };
        let item = items
            .iter()
            .find(|item| !sent_ids.contains(item["id"].as_str().unwrap()))
            .unwrap();
        sent_ids.insert(item["id"].as_str().unwrap().to_owned());
        assert_eq!(item["payload"]["text"], expected);
        assert_eq!(item["payload"]["images"], json!([image.clone()]));
        assert_eq!(item["threadId"], session.id);
        assert_eq!(item["status"], "queued");
        production_wire_oracle(&item["payload"]);
        surface.read_with(cx, |s, cx| {
            assert!(s.composer.read(cx).text.is_empty());
            assert!(s.composer.read(cx).controls.images.is_empty());
        });
    }
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(
        fixture.client.queue(&session).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        3,
        "an empty draft without attachments must still queue nothing"
    );
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

#[gpui::test]
fn native_composer_review_send_button_returns_focus_to_editor(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    surface.update(cx, |s, _| s.send_next = true);
    click("composer-input", cx);
    cx.simulate_input("Send with the pointer");
    click("send", cx);
    surface.update_in(cx, |s, window, cx| {
        assert!(s.composer.read(cx).text.is_empty());
        assert_eq!(
            s.queue["items"][0]["payload"]["text"],
            "Send with the pointer"
        );
        assert!(
            s.composer.read(cx).focus.is_focused(window),
            "successful pointer Send must return focus to the editor"
        );
    });
    cx.simulate_input("Continue typing immediately");
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).text, "Continue typing immediately")
    });
    surface.update_in(cx, |s, window, cx| {
        s.composer.read(cx).controls.focus["send"].focus(window)
    });
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    surface.update_in(cx, |s, window, cx| {
        assert!(s.composer.read(cx).text.is_empty());
        assert!(
            s.composer.read(cx).focus.is_focused(window),
            "keyboard activation of Send must also restore the editor"
        );
    });
}

fn loaded<'a>(
    cx: &'a mut TestAppContext,
    fixture: &Fixture,
) -> (gpui::Entity<Surface>, &'a mut VisualTestContext) {
    let (surface, cx) = open(cx, fixture);
    cx.simulate_resize(gpui::size(px(1200.), px(816.)));
    surface.update(cx, |s, cx| s.select("thoughts-composer-loaded".into(), cx));
    cx.run_until_parked();
    // Exercise history pagination through the production client until all 200
    // fixed messages are installed. No synthetic rows bypass the renderer.
    for _ in 0..3 {
        if surface.read_with(cx, |s, _| s.rows.len()) >= 200 {
            break;
        }
        surface.update(cx, |s, cx| s.load_older(cx));
        cx.run_until_parked();
    }
    click("composer-input", cx);
    surface.read_with(cx, |s, _| assert_eq!(s.rows.len(), 200));
    (surface, cx)
}

#[gpui::test]
fn native_composer_loaded_typing_invalidates_only_editor(cx: &mut TestAppContext) {
    let fixture = Fixture::with_loaded(true);
    let (surface, cx) = loaded(cx, &fixture);
    let notifications = Rc::new(Cell::new(0));
    let observed = notifications.clone();
    let _subscription =
        cx.update(|_, cx| cx.observe(&surface, move |_, _| observed.set(observed.get() + 1)));
    let layouts = surface.read_with(cx, |s, _| {
        s.painted_rows.borrow_mut().clear();
        s.rows
            .iter()
            .map(|row| row.borrow().layouts)
            .collect::<Vec<_>>()
    });
    let renders = surface.read_with(cx, |s, cx| s.regions.renders(cx));
    cx.update(|window, cx| {
        window.dispatch_keystroke(Keystroke::parse("a").unwrap(), cx);
    });
    // A normal first CPU scene, without Window::refresh (which intentionally
    // discards GPUI's view caches). A second scene must not be needed to paint.
    cx.update(|window, cx| window.draw(cx).clear());
    surface.read_with(cx, |s, cx| {
        let editor = s.composer.read(cx);
        assert_eq!(editor.text, "a");
        assert_eq!(editor.revision, editor.painted);
        assert_eq!(notifications.get(), 0, "typing must not notify the session");
        assert_eq!(
            s.regions.renders(cx),
            renders,
            "typing must not render sibling views"
        );
        assert!(
            s.painted_rows.borrow().is_empty(),
            "typing must reuse the transcript scene, without laying out or painting its rows"
        );
        assert_eq!(
            s.rows
                .iter()
                .map(|row| row.borrow().layouts)
                .collect::<Vec<_>>(),
            layouts,
            "unchanged rows must reuse shaped text"
        );
    });
}

#[gpui::test]
fn native_composer_loaded_typing_benchmark(cx: &mut TestAppContext) {
    let fixture = Fixture::with_loaded(true);
    let (surface, cx) = loaded(cx, &fixture);
    let mut samples = Vec::with_capacity(100);
    for count in 1..=100 {
        let start = Instant::now();
        cx.update(|window, cx| {
            window.dispatch_keystroke(Keystroke::parse("a").unwrap(), cx);
        });
        samples.push(start.elapsed().as_secs_f64() * 1000.);
        surface.read_with(cx, |s, cx| {
            let editor = s.composer.read(cx);
            assert_eq!(editor.text.len(), count);
            assert_eq!(
                editor.revision, editor.painted,
                "first scene must paint the edit"
            );
        });
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "LOADED_COMPOSER_CPU_SCENE platform={} profile={} messages=200 inputs=100 p50_ms={:.6} p95_ms={:.6}",
        std::env::consts::OS,
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        samples[49],
        samples[94]
    );
}

#[gpui::test]
fn native_composer_loaded_wrapping_keeps_transcript_geometry(cx: &mut TestAppContext) {
    let fixture = Fixture::with_loaded(true);
    let (surface, cx) = loaded(cx, &fixture);
    let before = cx.debug_bounds("composer-card").unwrap();
    let regions = surface.read_with(cx, |s, cx| s.regions.renders(cx));
    cx.write_to_clipboard(gpui::ClipboardItem::new_string(
        "a long draft line\n".repeat(20),
    ));
    cx.simulate_keystrokes("ctrl-v");
    for _ in 0..2 {
        cx.update(|window, cx| window.draw(cx).clear());
    }
    assert_eq!(
        cx.debug_bounds("composer-card").unwrap(),
        before,
        "growing a draft must scroll inside the composer, without resizing the conversation"
    );
    surface.read_with(cx, |s, cx| assert_eq!(s.regions.renders(cx), regions));
    let viewport = cx.debug_bounds("composer-input").unwrap();
    surface.update_in(cx, |s, window, cx| {
        s.composer.update(cx, |i, cx| {
            let end = i.text.encode_utf16().count();
            let caret = gpui::EntityInputHandler::bounds_for_range(
                i,
                end..end,
                gpui::Bounds::default(),
                window,
                cx,
            )
            .expect("native caret bounds");
            assert!(
                caret.top() >= viewport.top() && caret.bottom() <= viewport.bottom(),
                "the fixed composer viewport must scroll the insertion point into view"
            );
        });
    });
}

#[gpui::test]
fn native_composer_loaded_resize_reshapes_rows_then_resumes_isolation(cx: &mut TestAppContext) {
    let fixture = Fixture::with_loaded(true);
    let (surface, cx) = loaded(cx, &fixture);
    let row = surface.read_with(cx, |s, _| {
        s.rows[s.list.logical_scroll_top().item_ix].clone()
    });
    let before = row.borrow().layouts;
    cx.simulate_resize(gpui::size(px(900.), px(700.)));
    for _ in 0..2 {
        cx.update(|window, cx| window.draw(cx).clear());
    }
    assert!(
        row.borrow().layouts > before,
        "a width change must reshape retained text"
    );
    let renders = surface.read_with(cx, |s, cx| s.regions.renders(cx));
    cx.update(|window, cx| {
        window.dispatch_keystroke(Keystroke::parse("a").unwrap(), cx);
    });
    cx.update(|window, cx| window.draw(cx).clear());
    surface.read_with(cx, |s, cx| assert_eq!(s.regions.renders(cx), renders));
}

#[gpui::test]
fn native_composer_loaded_focus_and_pending_switch_keep_current_scene(cx: &mut TestAppContext) {
    let fixture = Fixture::with_loaded(true);
    let (surface, cx) = loaded(cx, &fixture);
    let old_editor = surface.read_with(cx, |s, _| s.composer.clone());
    cx.simulate_input("Retained draft");
    surface.update(cx, |s, cx| s.select("thoughts-composer-first".into(), cx));
    // The history request is still pending. A late notification from the old
    // input must neither replace the selected transcript nor steal its focus.
    old_editor.update(cx, |i, cx| i.set_text("Late draft", cx));
    cx.run_until_parked();
    surface.update_in(cx, |s, window, cx| {
        assert_eq!(s.selected.as_deref(), Some("thoughts-composer-first"));
        assert_eq!(s.rows.len(), 1);
        s.composer.read(cx).focus.focus(window);
    });
    for _ in 0..2 {
        cx.update(|window, cx| window.draw(cx).clear());
    }
    cx.update(|window, _| window.blur());
    surface.update_in(cx, |s, window, cx| s.composer.read(cx).focus.focus(window));
    for _ in 0..2 {
        cx.update(|window, cx| window.draw(cx).clear());
    }
    let renders = surface.read_with(cx, |s, cx| s.regions.renders(cx));
    cx.simulate_keystrokes("x");
    cx.update(|window, cx| window.draw(cx).clear());
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).text, "x");
        assert_eq!(s.regions.renders(cx), renders);
        assert_eq!(old_editor.read(cx).text, "Late draft");
    });
}

#[test]
fn model_names_read_like_the_desktop() {
    use crate::composer::controls::model_label;
    for (id, label) in [
        ("gpt-6.1-sol", "GPT-6.1 Sol"),
        ("gpt-5.6-terra", "GPT-5.6 Terra"),
        ("gpt-5.5", "GPT-5.5"),
        ("gpt-5.3-codex", "Codex 5.3"),
        ("claude-opus-5-5", "Opus 5.5"),
        ("claude-fable-5[1m]", "Fable 5 (1M)"),
        ("claude-sonnet-4-20250514", "Sonnet 4"),
        ("gemini-3-flash-preview", "Gemini 3 Flash"),
        ("local-model", "local-model"),
    ] {
        assert_eq!(model_label(id), label);
    }
}
