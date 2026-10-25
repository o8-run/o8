//! Real-path coverage for the Symon FRONT brain seam (#2164).
//!
//! These drive the entry points the gesture actually takes — the resolve the
//! agent loop calls, the `ask` the Right-Option Ask lane calls, and the first
//! prompt the planner loop sends — against the pref file the settings panel
//! writes, with real fixture processes on the other end. A resolver that is
//! right proves nothing if the loop never asks it, so every assertion here goes
//! through the caller rather than the helper.

use super::*;
use serde_json::json;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// The fixture drives the planner registry through its env overrides and a
/// throwaway data dir, the same way `planner_seat_tests::SeatFixture` does.
/// This one additionally guarantees NO Gemini credential: no key in the env, no
/// key in the pref file, and no entitlement token in the data dir — so any test
/// that lands on the built-in loop is landing there on the route's own logic
/// and any planner run here is running without a Gemini fallback underneath it.
#[cfg(unix)]
struct FrontFixture {
    dir: std::path::PathBuf,
    capture: std::path::PathBuf,
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(unix)]
impl FrontFixture {
    fn new(prefs: serde_json::Value) -> Self {
        Self::with_installed(prefs, &["claude", "codex", "opencode"])
    }

    /// `installed` names the adapters whose fixture binary exists; every other
    /// adapter's env override points at a path that is not there, which is how
    /// a "chosen CLI is missing" case is staged without touching the machine.
    fn with_installed(prefs: serde_json::Value, installed: &[&str]) -> Self {
        let guard = crate::DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "o8-front-brain-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let capture = dir.join("capture.txt");

        // Holds stdin open the way the resident CLIs do, so a spawned session
        // stays alive until it is dropped.
        let resident = "#!/bin/sh\n\
             FRONT_CAPTURE=\"$(dirname \"$0\")/capture.txt\"\n\
             FRONT_TURNS=\"$(dirname \"$0\")/turns.txt\"\n\
             FRONT_SCRIPT=\"$(dirname \"$0\")/script.txt\"\n\
                        for arg in \"$@\"; do printf 'argv %s\\n' \"$arg\" >> \"$FRONT_CAPTURE\"; done\n\
                        printf '%s\\n' '__END__' >> \"$FRONT_CAPTURE\"\n\
                        cat > /dev/null\n";
        for name in ["claude-fixture", "codex-fixture"] {
            let path = dir.join(name);
            std::fs::write(&path, resident).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // One process PER TURN: records argv and answers on stdout in the real
        // NDJSON shape. A turn counter walks a scripted script of replies, so a
        // multi-tool task can actually run to completion against it.
        let opencode = dir.join("opencode-fixture");
        std::fs::write(
            &opencode,
            "#!/bin/sh\n\
             FRONT_CAPTURE=\"$(dirname \"$0\")/capture.txt\"\n\
             FRONT_TURNS=\"$(dirname \"$0\")/turns.txt\"\n\
             FRONT_SCRIPT=\"$(dirname \"$0\")/script.txt\"\n\
             for arg in \"$@\"; do printf 'argv %s\\n' \"$arg\" >> \"$FRONT_CAPTURE\"; done\n\
             printf '%s\\n' '__END__' >> \"$FRONT_CAPTURE\"\n\
             turn=0\n\
             if [ -f \"$FRONT_TURNS\" ]; then turn=$(cat \"$FRONT_TURNS\"); fi\n\
             next=$((turn + 1))\n\
             printf '%s' \"$next\" > \"$FRONT_TURNS\"\n\
             action=$(sed -n \"${next}p\" \"$FRONT_SCRIPT\")\n\
             if [ -z \"$action\" ]; then action='{\\\"done\\\":true,\\\"say\\\":\\\"All set.\\\"}'; fi\n\
             printf '{\"type\":\"text\",\"sessionID\":\"ses_fixture\",\"part\":{\"type\":\"text\",\"text\":\"%s\"}}\\n' \"$action\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&opencode, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::fs::write(dir.join("operator-defaults.json"), "{\"orchestratorBackend\":\"codex\"}")
            .unwrap();
        std::fs::write(dir.join("dictation.json"), prefs.to_string()).unwrap();
        // Default script: answer any turn with a plain-prose sentence (the Ask
        // shape). Tool tests overwrite it.
        std::fs::write(dir.join("script.txt"), "The dock is on the left.\n").unwrap();

        let keys = [
            "O8_DATA_DIR",
            "CORTEX_IDE_DATA_DIR",
            "O8_CLAUDE_CODE_BIN",
            "CLAUDE_BIN",
            "O8_CODEX_BIN",
            "CODEX_BIN",
            "O8_OPENCODE_BIN",
            "OPENCODE_BIN",
            "GEMINI_API_KEY",
            "FRONT_CAPTURE",
            "FRONT_TURNS",
            "FRONT_SCRIPT",
        ];
        let previous = keys
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect();
        std::env::set_var("O8_DATA_DIR", &dir);
        std::env::remove_var("CORTEX_IDE_DATA_DIR");
        // No Gemini credential anywhere.
        std::env::remove_var("GEMINI_API_KEY");
        let missing = dir.join("not-installed");
        let bin = |id: &str, file: &str| {
            if installed.contains(&id) {
                dir.join(file)
            } else {
                missing.clone()
            }
        };
        std::env::set_var("O8_CLAUDE_CODE_BIN", bin("claude", "claude-fixture"));
        std::env::remove_var("CLAUDE_BIN");
        std::env::set_var("O8_CODEX_BIN", bin("codex", "codex-fixture"));
        std::env::remove_var("CODEX_BIN");
        std::env::set_var("O8_OPENCODE_BIN", bin("opencode", "opencode-fixture"));
        std::env::remove_var("OPENCODE_BIN");
        std::env::set_var("FRONT_CAPTURE", &capture);
        std::env::set_var("FRONT_TURNS", dir.join("turns.txt"));
        std::env::set_var("FRONT_SCRIPT", dir.join("script.txt"));
        Self {
            dir,
            capture,
            previous,
            _guard: guard,
        }
    }

    /// One planner action (or prose reply) per line, consumed in order.
    fn script(&self, lines: &[&str]) {
        std::fs::write(self.dir.join("script.txt"), format!("{}\n", lines.join("\n"))).unwrap();
    }

    /// The whole capture, prompt continuation lines included.
    fn captured_raw(&self) -> String {
        self.captured_argv();
        std::fs::read_to_string(&self.capture).unwrap_or_default()
    }

    fn captured_argv(&self) -> Vec<String> {
        for _ in 0..200 {
            let captured = std::fs::read_to_string(&self.capture).unwrap_or_default();
            if captured.contains("__END__") {
                return captured
                    .lines()
                    .filter_map(|line| line.strip_prefix("argv ").map(str::to_string))
                    .collect();
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("fixture never recorded its argv");
    }
}

#[cfg(unix)]
impl Drop for FrontFixture {
    fn drop(&mut self) {
        for (key, value) in &self.previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Reports only `installed` as present, whatever this machine actually has.
fn locator(
    installed: &'static [&'static str],
) -> impl FnMut(&planner_route::PlannerAdapter) -> Option<String> {
    move |adapter| {
        installed
            .contains(&adapter.id)
            .then(|| format!("/fixture/{}", adapter.id))
    }
}

#[cfg(unix)]
fn front_ctx(escalate_available: bool) -> TaskCtx {
    front_ctx_named("front-brain-test", escalate_available)
}

/// The loop speaks an opening filler for any task id that is not a background
/// one. Headless tests take the quiet id; nothing else in the loop reads it.
#[cfg(unix)]
fn front_ctx_named(task_id: &str, escalate_available: bool) -> TaskCtx {
    TaskCtx {
        task_id: task_id.into(),
        utterance: "what can you do".into(),
        ledger_session_id: None,
        machine_session_id: "desktop".into(),
        app: None,
        screen: None,
        spatial: false,
        crop_png_base64: None,
        edit: None,
        cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        escalate_available,
    }
}

/// The default. `auto` must seat exactly what the route seated before this
/// change — the background registry's own answer, model and effort included —
/// and it must pick the planner loop, not the built-in one.
#[cfg(unix)]
#[test]
fn auto_seats_exactly_what_the_background_route_seats() {
    let _fixture = FrontFixture::new(json!({}));
    let planner_route::PlannerRouting::Selected(background) = planner_route::resolve() else {
        panic!("the fixture CLIs are installed, so the background route seats one");
    };

    let routing = front_brain::resolve();
    let seat = routing
        .planner_selection()
        .expect("auto takes the planner loop while a CLI is installed");
    assert_eq!(seat.provider.id, background.provider.id);
    assert_eq!(seat.model, background.model);
    assert_eq!(seat.effort, background.effort);
    assert!(routing.gemini_model().is_none());
    assert!(routing.fell_back_from.is_none());
}

/// The floor `auto` adds: with no agent CLI at all the gesture used to fail
/// outright. Now it lands on the built-in loop instead.
#[cfg(unix)]
#[test]
fn auto_falls_to_the_built_in_loop_when_no_cli_is_installed() {
    let _fixture = FrontFixture::new(json!({}));
    let routing = front_brain::resolve_with(
        None,
        planner_route::PlannerRouting::Unavailable { message: "none" },
        "auto",
        true,
        locator(&[]),
    );
    assert!(routing.planner_selection().is_none());
    assert_eq!(routing.gemini_model(), Some(crate::models::GEMINI_3_FLASH_PREVIEW));
    // Nothing to escalate to: the handoff target is the route that just failed.
    assert!(!routing.escalate_available);
}

/// A registry id picks the text-planner loop on that seat — at the WORKER rung
/// by default, which is the front lane's own discipline rather than the
/// background seat's default (`codex` seats its builder rung there).
#[cfg(unix)]
#[test]
fn a_registry_id_seats_the_text_planner_loop_at_the_worker_rung() {
    let _fixture = FrontFixture::new(json!({ "symon_front_brain": "codex" }));
    let routing = front_brain::resolve();
    let seat = routing.planner_selection().expect("a registry id takes a planner seat");
    assert_eq!(seat.provider.id, "codex");
    assert_eq!(
        seat.provider.transport,
        planner_route::PlannerTransport::CodexAppServer
    );
    assert_eq!(seat.model.as_deref(), Some(crate::models::CODEX_GPT_5_6_TERRA));
    assert_eq!(seat.effort, "medium");

    // The background seat's own default is the other rung, and it is unmoved.
    let planner_route::PlannerRouting::Selected(background) = planner_route::resolve() else {
        panic!("the background route still seats a CLI");
    };
    assert_eq!(background.model.as_deref(), Some(planner_route::DEFAULT_CODEX_PLANNER_MODEL));
}

/// The operator's existing Symon brain tier and model pin still steer the front
/// seat when they set one — the front choice picks the adapter, not the rung.
#[cfg(unix)]
#[test]
fn the_brain_tier_and_model_pin_still_reach_the_front_seat() {
    {
        let _fixture = FrontFixture::new(json!({
            "symon_front_brain": "claude",
            "symon_brain_tier": "builder",
        }));
        let routing = front_brain::resolve();
        let seat = routing.planner_selection().unwrap();
        assert_eq!(seat.model.as_deref(), Some(planner_route::BUILDER_CLAUDE_PLANNER_MODEL));
        assert_eq!(seat.effort, "high");
    }
    {
        let _fixture = FrontFixture::new(json!({
            "symon_front_brain": "opencode",
            "symon_brain_model": "openrouter/some-model",
        }));
        let routing = front_brain::resolve();
        assert_eq!(
            routing.planner_selection().unwrap().model.as_deref(),
            Some("openrouter/some-model")
        );
    }
}

/// A chosen front brain whose binary is missing never fails the gesture: it
/// falls through, and both the log line and the settings state name the pick it
/// could not honor. With no Gemini credential in this fixture the fallback is
/// another installed seat rather than the built-in loop.
#[cfg(unix)]
#[test]
fn a_missing_front_binary_falls_back_and_says_so() {
    let _fixture = FrontFixture::new(json!({ "symon_front_brain": "opencode" }));
    let planner_route::PlannerRouting::Selected(background) = planner_route::resolve() else {
        panic!("the fixture CLIs back the background route");
    };

    // No Gemini credential in this fixture, so the fallback is another
    // installed seat rather than the built-in loop — and never nothing.
    let routing = front_brain::resolve_with(
        Some("opencode"),
        planner_route::PlannerRouting::Selected(background.clone()),
        "auto",
        false,
        locator(&["claude", "codex"]),
    );
    assert_eq!(routing.fell_back_from.as_deref(), Some("opencode"));
    assert_eq!(routing.brain.id(), background.provider.id);

    // With a Gemini credential the built-in loop takes it instead.
    let routing = front_brain::resolve_with(
        Some("opencode"),
        planner_route::PlannerRouting::Selected(background),
        "auto",
        true,
        locator(&["claude", "codex"]),
    );
    assert_eq!(routing.fell_back_from.as_deref(), Some("opencode"));
    assert_eq!(routing.brain.id(), "gemini");
}

/// The settings panel reads one state that names the seat the NEXT gesture
/// takes, plus every selectable seat — so a pick reads as a pick and a fallback
/// reads as a fallback rather than silently doing something else.
#[cfg(unix)]
#[test]
fn the_settings_state_names_the_seat_the_next_gesture_takes() {
    let _fixture = FrontFixture::new(json!({ "symon_front_brain": "codex" }));
    let state = serde_json::to_value(front_brain::state()).unwrap();
    assert_eq!(state["choice"], "codex");
    assert_eq!(state["resolvedId"], "codex");
    assert_eq!(state["resolvedModel"], crate::models::CODEX_GPT_5_6_TERRA);
    assert_eq!(state["fellBackFrom"], serde_json::Value::Null);

    // The built-in loop leads the list and is un-credentialed in this fixture;
    // every planner adapter follows, rendered from the native registry.
    let options = state["options"].as_array().unwrap();
    assert_eq!(options[0]["id"], "gemini");
    assert_eq!(options[0]["installed"], serde_json::Value::Bool(false));
    let ids: Vec<&str> = options.iter().filter_map(|row| row["id"].as_str()).collect();
    for adapter in planner_route::PLANNER_ADAPTERS {
        assert!(ids.contains(&adapter.id), "{} is selectable", adapter.id);
    }

    // And the same state rides the one command the panel already calls.
    let brain = serde_json::to_value(planner_route::brain_state()).unwrap();
    assert_eq!(brain["front"]["resolvedId"], "codex");
}

/// `escalate` is withheld when the two seats coincide (`auto` always does) and
/// offered when they genuinely differ — asserted through the REAL first prompt
/// the planner loop sends, not the flag on its own.
#[cfg(unix)]
#[test]
fn escalate_is_withheld_when_the_front_and_background_seats_coincide() {
    {
        let _fixture = FrontFixture::new(json!({}));
        let routing = front_brain::resolve();
        assert!(
            !routing.escalate_available,
            "auto seats the background brain itself — there is nothing to hand off to"
        );
        let ctx = front_ctx(routing.escalate_available);
        let prompt = claude::planner_payload::build_first_prompt("tidy my desktop", &ctx).prompt;
        assert!(
            !prompt.contains("\"name\":\"escalate\""),
            "the planner catalog must not offer a handoff to its own seat"
        );
    }
    {
        // A different adapter on the front seat IS a real handoff target.
        let _fixture = FrontFixture::new(json!({ "symon_front_brain": "claude" }));
        let routing = front_brain::resolve();
        assert_eq!(routing.brain.id(), "claude");
        assert!(
            routing.escalate_available,
            "the background brain resolves to codex here, a different seat"
        );
        let ctx = front_ctx(routing.escalate_available);
        let prompt = claude::planner_payload::build_first_prompt("tidy my desktop", &ctx).prompt;
        assert!(
            prompt.contains("\"name\":\"escalate\""),
            "the handoff is offered when it leads somewhere"
        );
    }
    {
        // The escalation policy still wins outright.
        let fixture = FrontFixture::new(json!({ "symon_front_brain": "claude" }));
        std::fs::write(
            fixture.dir.join("agent_models.json"),
            json!({ "voice_escalation": "off" }).to_string(),
        )
        .unwrap();
        assert!(!front_brain::resolve().escalate_available);
    }
}

/// Background brain tasks keep the infinite-handoff guard: the flag is never
/// set for them, so the catalog they receive is the one they always received.
#[cfg(unix)]
#[test]
fn a_background_brain_task_never_offers_the_handoff() {
    let _fixture = FrontFixture::new(json!({ "symon_front_brain": "claude" }));
    let prompt =
        claude::planner_payload::build_first_prompt("summarize the week", &front_ctx(false)).prompt;
    assert!(!prompt.contains("\"name\":\"escalate\""));
}

/// The acceptance case: front brain pinned to a non-Gemini adapter, no Gemini
/// key and no plan token anywhere, and a TWO-TOOL task runs to completion
/// through the planner loop — the real loop, a real process per turn, real tool
/// dispatch. `app: None` is the persisted headless seam, so the two tools are
/// ones that answer without the desktop handle.
#[cfg(unix)]
#[tokio::test]
async fn a_two_tool_task_completes_on_a_non_gemini_front_brain_with_no_gemini_key() {
    let fixture = FrontFixture::new(json!({ "symon_front_brain": "opencode" }));
    assert!(
        crate::entitlement::resolve_gemini(crate::models::GEMINI_3_FLASH_PREVIEW).is_none(),
        "the acceptance case runs with no Gemini key and no plan token"
    );
    fixture.script(&[
        r#"{\"tool\":\"symon_capabilities\",\"args\":{}}"#,
        r#"{\"tool\":\"symon_memory_list\",\"args\":{}}"#,
        r#"{\"done\":true,\"say\":\"Both checks are done.\"}"#,
    ]);

    let routing = front_brain::resolve();
    let seat = routing.planner_selection().expect("the open seat takes the turn").clone();
    assert_eq!(seat.provider.id, "opencode");

    let ctx = front_ctx_named("claude-task-front-brain", routing.escalate_available);
    let result = opencode::run_loop(&seat.binary, seat.model.as_deref(), "check yourself", &ctx)
        .await
        .expect("the planner loop completes");
    assert_eq!(result.result_text, "Both checks are done.");

    let calls: Vec<serde_json::Value> = serde_json::from_str(&result.tool_calls_json).unwrap();
    let names: Vec<&str> = calls
        .iter()
        .filter_map(|call| call.get("tool").and_then(|name| name.as_str()))
        .collect();
    assert_eq!(names, vec!["symon_capabilities", "symon_memory_list"]);
    assert!(
        calls.iter().all(|call| call["ok"] == serde_json::Value::Bool(true)),
        "both tools ran for real: {calls:?}"
    );
}

/// Ask mode on a planner seat: ONE turn, the Ask persona, and no tool catalog
/// at all — asserted on the argv and the prompt the real process received.
#[cfg(unix)]
#[tokio::test]
async fn ask_mode_answers_on_the_front_seat_with_tools_withheld() {
    let fixture = FrontFixture::new(json!({ "symon_front_brain": "opencode" }));
    fixture.script(&["The dock is on the left."]);

    let answer = front_brain::ask("where is my dock", None)
        .await
        .expect("the front seat answers");
    assert_eq!(answer, "The dock is on the left.");

    let sent = fixture.captured_raw();
    assert!(sent.contains("Question: where is my dock"));
    assert!(
        !sent.contains("AVAILABLE TOOLS"),
        "Ask withholds the tool catalog entirely"
    );
    assert!(
        !sent.contains("HOW YOU ACT"),
        "Ask sends no planner contract — it is one question, not a loop"
    );
    let argv = fixture.captured_argv();
    // The read-only posture the seat spawns with is still enforced underneath.
    assert!(argv.windows(2).any(|pair| pair == ["--agent", "plan"]));
    assert!(argv.iter().any(|arg| arg == "--pure"));
}

/// A planner seat that answers with an action object anyway is read for its
/// spoken sentence rather than having JSON spoken aloud.
#[test]
fn an_action_shaped_ask_reply_is_read_for_its_spoken_sentence() {
    assert_eq!(
        front_brain::plain_answer(r#"{"done": true, "say": "Nine windows are open."}"#),
        "Nine windows are open."
    );
    assert_eq!(front_brain::plain_answer("  Plain prose.  "), "Plain prose.");
}

/// The Ask prompt carries the same persona the built-in path uses, so the two
/// seats answer in one voice.
#[test]
fn the_ask_prompt_carries_the_shared_persona_and_the_question() {
    let prompt = front_brain::build_ask_prompt("what is on my screen", Some("Finder is frontmost"));
    assert!(prompt.starts_with(crate::ai::gemini_ask::ASK_SYSTEM_PROMPT));
    assert!(prompt.contains("[On-screen context]\nFinder is frontmost"));
    assert!(prompt.contains("Question: what is on my screen"));
    assert!(prompt.contains("no tools on this turn") || prompt.contains("no tools"));
}
