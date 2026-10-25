//! Real-path coverage for the background planner seat (#2155, #2156).
//!
//! The `escalate` handoff used to pin the frontier orchestrator model, and
//! before that it could only reach two CLIs. These tests drive the REAL entry
//! points — the tool dispatch, the env-backed planner registry, and the process
//! spawn — rather than the resolver helper on its own, because the resolver
//! being right proves nothing if the spawn site never asks it.

use super::*;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Headless task context. `app: None` is the persisted read-only seam the tool
/// dispatch already supports — every app-dependent action fails closed.
fn headless_ctx() -> TaskCtx {
    TaskCtx {
        task_id: "planner-seat-test".into(),
        utterance: "go through my calendar and draft the summary".into(),
        ledger_session_id: None,
        machine_session_id: "desktop".into(),
        app: None,
        screen: None,
        spatial: false,
        crop_png_base64: None,
        edit: None,
        cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        escalate_available: false,
    }
}

#[tokio::test]
async fn escalate_reaches_the_background_planner_handoff_without_naming_a_vendor() {
    let ctx = headless_ctx();

    // Guard first: an empty task never reaches the handoff at all.
    let empty = tools::dispatch_tool_call(
        "escalate",
        json!({ "task": "   ", "target": "claude_brain" }),
        &ctx,
    )
    .await;
    assert_eq!(
        empty.unwrap_err(),
        "escalate requires a non-empty `task`",
        "the empty-task guard must fire before any handoff"
    );

    // The real dispatch takes the background-brain branch, whose only remaining
    // dependency headless is the desktop handle `spawn_background_brain_task`
    // needs. That spawn resolves its seat through `planner_route::resolve()` —
    // with no model override — which the seat tests below pin down.
    let handed_off = tools::dispatch_tool_call(
        "escalate",
        json!({ "task": "summarize this week's calendar", "target": "claude_brain" }),
        &ctx,
    )
    .await;
    assert_eq!(
        handed_off.unwrap_err(),
        "This action requires the live o8 desktop app"
    );
}

#[cfg(unix)]
struct SeatFixture {
    dir: std::path::PathBuf,
    capture: std::path::PathBuf,
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(unix)]
impl SeatFixture {
    /// Point the planner at fixture binaries for every registry entry and a
    /// throwaway data dir carrying the operator defaults under test. Nothing
    /// real in `~/.o8` is read or written.
    fn new(orchestrator_backend: &str) -> Self {
        Self::with_brain_setting(orchestrator_backend, None)
    }

    /// Same, plus the operator's Symon brain setting written into the voice
    /// pref file the way `voice_prefs_set` writes it.
    fn with_brain_setting(orchestrator_backend: &str, brain: Option<serde_json::Value>) -> Self {
        let guard = crate::DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "o8-planner-seat-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let capture = dir.join("capture.txt");
        // Records argv, then holds stdin open the way the real CLIs do so the
        // spawned session stays alive until it is dropped.
        let script = "#!/bin/sh\n\
             SEAT_CAPTURE=\"$(dirname \"$0\")/capture.txt\"\n\
                      for arg in \"$@\"; do printf 'argv %s\\n' \"$arg\" >> \"$SEAT_CAPTURE\"; done\n\
                      printf '%s\\n' '__END__' >> \"$SEAT_CAPTURE\"\n\
                      cat > /dev/null\n";
        for name in ["claude-fixture", "codex-fixture"] {
            let path = dir.join(name);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // The opencode transport is one process PER TURN rather than a held
        // child, so its fixture records argv and then answers on stdout in the
        // NDJSON shape the real CLI emits — enough for the adapter to parse a
        // session id and a planner action back out of a real spawn.
        let opencode_fixture = dir.join("opencode-fixture");
        std::fs::write(
            &opencode_fixture,
            "#!/bin/sh\n\
             SEAT_CAPTURE=\"$(dirname \"$0\")/capture.txt\"\n\
             for arg in \"$@\"; do printf 'argv %s\\n' \"$arg\" >> \"$SEAT_CAPTURE\"; done\n\
             printf '%s\\n' '__END__' >> \"$SEAT_CAPTURE\"\n\
             printf '%s\\n' '{\"type\":\"text\",\"sessionID\":\"ses_fixture\",\"part\":{\"type\":\"text\",\"text\":\"{\\\"done\\\":true,\\\"say\\\":\\\"All set.\\\"}\"}}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&opencode_fixture, std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::write(
            dir.join("operator-defaults.json"),
            format!("{{\"orchestratorBackend\":\"{orchestrator_backend}\"}}"),
        )
        .unwrap();
        if let Some(brain) = brain {
            std::fs::write(dir.join("dictation.json"), brain.to_string()).unwrap();
        }

        let previous = [
            "O8_DATA_DIR",
            "CORTEX_IDE_DATA_DIR",
            "O8_CLAUDE_CODE_BIN",
            "CLAUDE_BIN",
            "O8_CODEX_BIN",
            "CODEX_BIN",
            "O8_OPENCODE_BIN",
            "OPENCODE_BIN",
            "SEAT_CAPTURE",
            "CODEX_HOME",
        ]
        .into_iter()
        .map(|key| (key, std::env::var_os(key)))
        .collect();
        std::env::set_var("O8_DATA_DIR", &dir);
        std::env::remove_var("CORTEX_IDE_DATA_DIR");
        std::env::set_var("O8_CLAUDE_CODE_BIN", dir.join("claude-fixture"));
        std::env::remove_var("CLAUDE_BIN");
        std::env::set_var("O8_CODEX_BIN", dir.join("codex-fixture"));
        std::env::remove_var("CODEX_BIN");
        std::env::set_var("O8_OPENCODE_BIN", &opencode_fixture);
        std::env::remove_var("OPENCODE_BIN");
        std::env::set_var("SEAT_CAPTURE", &capture);
        std::env::set_var("CODEX_HOME", dir.join("codex-home"));
        Self {
            dir,
            capture,
            previous,
            _guard: guard,
        }
    }

    /// Wait for `expected` fixture spawns and return each one's argv on its
    /// own. The fixture appends to a single capture file and closes every run
    /// with `__END__`, so a multi-turn path is read run by run rather than as
    /// one flattened list.
    fn captured_runs(&self, expected: usize) -> Vec<Vec<String>> {
        for _ in 0..200 {
            let captured = std::fs::read_to_string(&self.capture).unwrap_or_default();
            if captured.matches("__END__").count() >= expected {
                return captured
                    .split("__END__")
                    .take(expected)
                    .map(|run| {
                        run.lines()
                            .filter_map(|line| line.strip_prefix("argv ").map(str::to_string))
                            .collect()
                    })
                    .collect();
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("fixture recorded fewer than {expected} runs");
    }

    /// Wait for the spawned fixture to finish writing its argv.
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
impl Drop for SeatFixture {
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

#[cfg(unix)]
#[test]
fn claude_backend_seats_the_worker_tier_and_spawns_it_without_an_effort_flag() {
    let fixture = SeatFixture::new("claude");
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("both fixture CLIs are installed, so the route must select one");
    };
    assert_eq!(selection.provider.id, "claude");
    assert_eq!(selection.model.as_deref(), Some(crate::models::CLAUDE_SONNET_5));
    assert_eq!(selection.effort, "medium");

    // The constructed command, not the resolver: spawn the planner exactly the
    // way `claude::run_loop_with_binary` does and read back its argv.
    let mcp_cfg = claude::ensure_empty_mcp_config().unwrap();
    let session = claude::ClaudeSession::spawn(&selection.binary, selection.model_label(), &mcp_cfg)
        .expect("planner session spawns");
    let argv = fixture.captured_argv();
    drop(session);

    let model_at = argv.iter().position(|arg| arg == "--model").unwrap();
    assert_eq!(argv[model_at + 1], crate::models::CLAUDE_SONNET_5);
    assert!(
        !argv.iter().any(|arg| arg == "--effort"),
        "the worker tier runs at the CLI default — no --effort flag: {argv:?}"
    );
    // Tools stay hard-locked off on the planner seat.
    assert!(argv.iter().any(|arg| arg == "--strict-mcp-config"));
    assert!(argv.iter().any(|arg| arg == "--tools"));
}

#[cfg(unix)]
#[test]
fn builder_tier_pin_still_carries_the_high_effort_flag() {
    let fixture = SeatFixture::new("claude");
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve_bound(
        "claude",
        planner_route::BUILDER_CLAUDE_PLANNER_MODEL,
        "high",
    ) else {
        panic!("an explicit builder pin must resolve");
    };
    assert_eq!(selection.model.as_deref(), Some(crate::models::CLAUDE_OPUS_5));
    assert_eq!(selection.effort, "high");

    let mcp_cfg = claude::ensure_empty_mcp_config().unwrap();
    let session = claude::ClaudeSession::spawn(&selection.binary, selection.model_label(), &mcp_cfg)
        .expect("planner session spawns");
    let argv = fixture.captured_argv();
    drop(session);

    let effort_at = argv
        .iter()
        .position(|arg| arg == "--effort")
        .expect("the builder tier carries --effort");
    assert_eq!(argv[effort_at + 1], "high");
    let model_at = argv.iter().position(|arg| arg == "--model").unwrap();
    assert_eq!(argv[model_at + 1], crate::models::CLAUDE_OPUS_5);
}

#[cfg(unix)]
#[test]
fn codex_backend_seats_the_codex_builder_tier() {
    let _fixture = SeatFixture::new("codex");
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("both fixture CLIs are installed, so the route must select one");
    };
    assert_eq!(selection.provider.id, "codex");
    assert_eq!(
        selection.model.as_deref(),
        Some(planner_route::DEFAULT_CODEX_PLANNER_MODEL)
    );
    assert_eq!(selection.effort, "high");
}

#[cfg(unix)]
#[test]
fn every_backend_setting_resolves_off_the_frontier_tier() {
    for backend in ["auto", "codex", "claude", "collide", "fable", "openclaw", "hermes"] {
        let _fixture = SeatFixture::new(backend);
        let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
            panic!("both fixture CLIs are installed, so the route must select one ({backend})");
        };
        assert_ne!(
            selection.model.as_deref(),
            Some(crate::models::CLAUDE_FABLE_5),
            "backend {backend} must not seat the frontier orchestrator model"
        );
        assert!(
            matches!(
                selection.model.as_deref(),
                Some(crate::models::CLAUDE_SONNET_5) | Some(crate::models::CODEX_GPT_5_6_SOL)
            ),
            "backend {backend} seated {}",
            selection.model_label()
        );
    }
}

/// The operator's Symon brain setting, written the way `voice_prefs_set` writes
/// it, must reach the seat the very next task resolves — no relaunch. The keys
/// are spelled out here on purpose: this is the on-disk contract with the
/// settings panel, and `planner_route` asserts the constants match.
#[cfg(unix)]
#[test]
fn the_brain_setting_picks_the_seat_on_the_next_resolve() {
    // Orchestrator backend says Claude; the operator's brain setting says
    // otherwise, and the setting wins.
    let fixture =
        SeatFixture::with_brain_setting("claude", Some(json!({ "symon_brain_provider": "codex" })));
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("the chosen provider's fixture binary is installed");
    };
    assert_eq!(selection.provider.id, "codex");
    assert_eq!(
        selection.model.as_deref(),
        Some(planner_route::DEFAULT_CODEX_PLANNER_MODEL)
    );

    // The same file, rewritten in place, moves the seat on the next read.
    std::fs::write(
        fixture.dir.join("dictation.json"),
        json!({ "symon_brain_provider": "claude", "symon_brain_tier": "builder" }).to_string(),
    )
    .unwrap();
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("the chosen provider's fixture binary is installed");
    };
    assert_eq!(selection.provider.id, "claude");
    assert_eq!(
        selection.model.as_deref(),
        Some(planner_route::BUILDER_CLAUDE_PLANNER_MODEL)
    );
    assert_eq!(selection.effort, "high");
}

/// The open seat end to end through a REAL process: the env-backed registry
/// resolves it, the adapter spawns it, and a planner action is parsed back out.
/// Asserts the argv the spawn actually used.
#[cfg(unix)]
#[test]
fn the_open_seat_spawns_a_read_only_run_and_carries_its_thread() {
    let fixture = SeatFixture::with_brain_setting(
        "codex",
        Some(json!({ "symon_brain_provider": "opencode" })),
    );
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("the opencode fixture binary is installed");
    };
    assert_eq!(selection.provider.id, "opencode");
    assert_eq!(
        selection.provider.transport,
        planner_route::PlannerTransport::OpencodeRun
    );
    // o8 pins no model for an open runtime, and reports the effort as the
    // operator's own rather than inventing one.
    assert_eq!(selection.model, None);
    assert_eq!(selection.effort, planner_route::RUNTIME_CONFIGURED_EFFORT);

    // Spawn it the way `opencode::run_loop` does and read back the real argv.
    let mut session = opencode::OpencodeSession::new(&selection.binary, selection.model.as_deref());
    let answer = claude::TextPlannerSession::send_planner_turn(&mut session, "plan this", None)
        .expect("the fixture answers one turn");
    assert_eq!(answer, r#"{"done":true,"say":"All set."}"#);

    let argv = fixture.captured_argv();
    assert_eq!(argv[0], "run");
    assert!(argv.windows(2).any(|pair| pair == ["--format", "json"]));
    // Read-only agent + no plugins: the enforced backstop behind the planner
    // contract, matching the other two seats' tool locks.
    assert!(argv.windows(2).any(|pair| pair == ["--agent", "plan"]));
    assert!(argv.iter().any(|arg| arg == "--pure"));
    assert!(
        !argv.iter().any(|arg| arg == "--auto"),
        "the planner seat never auto-approves permissions: {argv:?}"
    );
    assert!(
        !argv.iter().any(|arg| arg == "--model"),
        "no operator pin means no o8-chosen model: {argv:?}"
    );
    assert_eq!(argv[argv.len() - 2], "--");
    assert_eq!(argv[argv.len() - 1], "plan this");
}

/// An operator model pin rides the open seat's real spawn.
#[cfg(unix)]
#[test]
fn an_operator_model_pin_reaches_the_open_seat_spawn() {
    let fixture = SeatFixture::with_brain_setting(
        "codex",
        Some(json!({
            "symon_brain_provider": "opencode",
            "symon_brain_model": "openrouter/some-model",
        })),
    );
    let planner_route::PlannerRouting::Selected(selection) = planner_route::resolve() else {
        panic!("the opencode fixture binary is installed");
    };
    assert_eq!(
        selection.model.as_deref(),
        Some("openrouter/some-model"),
        "an operator pin overrides the runtime's configured model"
    );

    let mut session = opencode::OpencodeSession::new(&selection.binary, selection.model.as_deref());
    claude::TextPlannerSession::send_planner_turn(&mut session, "plan this", None).unwrap();
    let argv = fixture.captured_argv();
    let model_at = argv
        .iter()
        .position(|arg| arg == "--model")
        .expect("the pin is passed");
    assert_eq!(argv[model_at + 1], "openrouter/some-model");
}

/// The bound text surface (phone / managed messages) binds a seat by its
/// registry id, not by a model triple (#2176). This drives the REAL entry
/// points — `symon_text_planner_info` for what the surface is told, then the
/// bound run path twice on one conversation — because the registry resolving
/// an open seat proves nothing if the surface the operator texts cannot take
/// it.
#[cfg(unix)]
#[tokio::test]
async fn the_open_seat_binds_the_text_surface_and_the_next_turn_resumes_it() {
    let fixture = SeatFixture::with_brain_setting(
        "codex",
        Some(json!({ "symon_brain_provider": "opencode" })),
    );
    bound_seat::reset();

    // What the surface is told: a seat with no o8-side model id is BINDABLE,
    // and it is named the way Settings → Voice names it.
    let rendered = serde_json::to_value(symon_text_planner_info(None, None, None)).unwrap();
    assert_eq!(rendered["available"], serde_json::Value::Bool(true));
    assert_eq!(rendered["engine"], "opencode");
    assert_eq!(rendered["model"], planner_route::RUNTIME_CONFIGURED_MODEL);
    assert_eq!(rendered["effort"], planner_route::RUNTIME_CONFIGURED_EFFORT);
    assert_eq!(rendered["seat"], "opencode · runtime-configured");

    // And the triple it just handed out comes back through the BOUND entry —
    // the surface re-presents it on every later turn.
    let bound = serde_json::to_value(symon_text_planner_info(
        Some("opencode"),
        Some(planner_route::RUNTIME_CONFIGURED_MODEL),
        Some(planner_route::RUNTIME_CONFIGURED_EFFORT),
    ))
    .unwrap();
    assert_eq!(bound["available"], serde_json::Value::Bool(true));
    assert_eq!(bound["engine"], "opencode");
    assert_eq!(bound["seat"], "opencode · runtime-configured");

    // Two real turns on one conversation, through the run path the Tauri
    // command calls. `app: None` is the headless seam.
    let session_id = "symon-text-2176";
    for turn_id in ["turn-1", "turn-2"] {
        let result = run_symon_text_turn_with(
            None,
            session_id.to_string(),
            turn_id.to_string(),
            "what is on my calendar?".to_string(),
            "opencode".to_string(),
            planner_route::RUNTIME_CONFIGURED_MODEL.to_string(),
            planner_route::RUNTIME_CONFIGURED_EFFORT.to_string(),
            false,
        )
        .await
        .unwrap_or_else(|error| panic!("{turn_id} must reach the open seat: {error}"));
        assert_eq!(result.text, "All set.");
    }

    let runs = fixture.captured_runs(2);
    assert!(
        !runs[0].iter().any(|arg| arg == "--session"),
        "turn 1 opens the thread: {:?}",
        runs[0]
    );
    let resumed_at = runs[1]
        .iter()
        .position(|arg| arg == "--session")
        .unwrap_or_else(|| panic!("turn 2 must resume turn 1's thread: {:?}", runs[1]));
    assert_eq!(runs[1][resumed_at + 1], "ses_fixture");
    // The marker is a binding token, never a model — it must not have reached
    // the CLI.
    for run in &runs {
        assert!(
            !run.iter().any(|arg| arg == "--model"),
            "the runtime-configured seat is spawned with no o8-chosen model: {run:?}"
        );
        assert!(
            !run.iter().any(|arg| arg == planner_route::RUNTIME_CONFIGURED_MODEL),
            "the binding marker must never ride the spawn: {run:?}"
        );
    }
    bound_seat::reset();
}

/// New text sessions use the text default; re-presented bindings remain fixed.
#[cfg(unix)]
#[test]
fn an_unset_text_brain_projects_the_new_default_and_bound_seats_stay_fixed() {
    for (backend, engine, model, effort) in [
        ("codex", "codex", crate::models::CODEX_GPT_6_1_SOL, "high"),
        ("claude", "claude", crate::models::CLAUDE_SONNET_5, "medium"),
    ] {
        let _fixture = SeatFixture::new(backend);
        let rendered = serde_json::to_value(symon_text_planner_info(None, None, None)).unwrap();
        assert_eq!(rendered["available"], serde_json::Value::Bool(true), "{backend}");
        assert_eq!(rendered["engine"], engine, "{backend}");
        assert_eq!(rendered["model"], model, "{backend}");
        assert_eq!(rendered["effort"], effort, "{backend}");

        // The triple it hands out still round-trips through the bound entry.
        let bound =
            serde_json::to_value(symon_text_planner_info(Some(engine), Some(model), Some(effort)))
                .unwrap();
        assert_eq!(bound["available"], serde_json::Value::Bool(true), "{backend}");
        assert_eq!(bound["model"], model, "{backend}");

        // And a seat that HAS a model id refuses the open seat's binding
        // marker, so a stale binding cannot claim it.
        let marked = serde_json::to_value(symon_text_planner_info(
            Some(engine),
            Some(planner_route::RUNTIME_CONFIGURED_MODEL),
            Some(planner_route::RUNTIME_CONFIGURED_EFFORT),
        ))
        .unwrap();
        assert_eq!(marked["available"], serde_json::Value::Bool(false), "{backend}");
    }
}

/// The seat line the bound surface reports is the one Settings → Voice renders
/// — `label · model · effort`, collapsed for a runtime-configured seat.
#[cfg(unix)]
#[test]
fn the_bound_surface_names_the_seat_the_way_settings_does() {
    let _fixture = SeatFixture::new("codex");
    let rendered = serde_json::to_value(symon_text_planner_info(None, None, None)).unwrap();
    assert_eq!(
        rendered["seat"],
        format!("Codex · {} · high", crate::models::CODEX_GPT_6_1_SOL)
    );
}

/// Real bound entry and planner-info, with all disk/config access in the fixture.
#[cfg(unix)]
#[tokio::test]
async fn text_default_reports_fallback_and_old_bindings_stay_fixed() {
    let fixture = SeatFixture::new("codex");
    std::fs::write(fixture.dir.join("codex-fixture"), r#"#!/bin/sh
SEAT_CAPTURE="$(dirname "$0")/capture.txt"
for arg in "$@"; do printf 'argv %s\n' "$arg" >> "$SEAT_CAPTURE"; done
printf '%s\n' '__END__' >> "$SEAT_CAPTURE"
if [ "$1" = app-server ]; then exit 1; fi
for arg in "$@"; do
  if [ "$arg" = model=gpt-6.1-sol ]; then
    printf '%s\n' 'The '\''gpt-6.1-sol'\'' model is not supported when using Codex with a ChatGPT account.' >&2
    exit 1
  fi
done
printf '%s\n' '{"type":"thread.started","thread_id":"fixture-thread"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"done\":true,\"say\":\"Ready.\"}"}}'
"#).unwrap();
    let info = symon_text_planner_info(None, None, None);
    assert_eq!(info.model.as_deref(), Some("gpt-6.1-sol"));
    assert_eq!(info.effort, Some("high"));
    assert!(info.allow_default_fallback);
    let result = run_symon_text_turn_with(None, "text-default".into(), "turn-1".into(),
        "Hello".into(), "codex".into(), info.model.unwrap(), "high".into(), info.allow_default_fallback).await.unwrap();
    let result = serde_json::to_value(result).unwrap();
    assert_eq!(result["model"], "gpt-5.6-sol");
    assert_eq!(result["effort"], "high");
    assert_eq!(result["text"], "Ready.");
    let old = symon_text_planner_info(Some("codex"), Some("gpt-5.6-sol"), Some("high"));
    assert_eq!(old.model.as_deref(), Some("gpt-5.6-sol"));
    assert!(!old.allow_default_fallback);
    let pinned = run_symon_text_turn_with(None, "pinned".into(), "turn-1".into(),
        "Hello".into(), "codex".into(), "gpt-6.1-sol".into(), "high".into(), false).await;
    let pinned = pinned.unwrap();
    assert_eq!(pinned.status, "error", "unavailable explicit pins must remain explicit");
    assert_eq!(pinned.model, "gpt-6.1-sol");
    assert!(pinned.detail.unwrap().contains("not supported"));
}

/// Tauri's bound entry retains the adapter's selection even if the retry fails
/// or cancellation arrives while its blocking transport is still active.
#[cfg(unix)]
#[tokio::test]
async fn bound_text_terminal_failure_and_interrupt_keep_fallback_selection() {
    for interrupted in [false, true] {
        let fixture = SeatFixture::new("codex");
        let ready = fixture.dir.join("fallback-ready");
        let release = fixture.dir.join("fallback-release");
        let script = format!(r#"#!/bin/sh
SEAT_CAPTURE="$(dirname "$0")/capture.txt"
if [ "$1" = app-server ]; then exit 1; fi
for arg in "$@"; do
  if [ "$arg" = model=gpt-6.1-sol ]; then
    printf '%s\n' 'The '\''gpt-6.1-sol'\'' model is not supported when using Codex with a ChatGPT account.' >&2
    exit 1
  fi
done
touch '{}'
while [ ! -f '{}' ]; do sleep 0.01; done
printf '%s\n' 'fixture failure mentions gpt-6.1-sol but does not define the effective model' >&2
exit 1
"#, ready.display(), release.display());
        std::fs::write(fixture.dir.join("codex-fixture"), script).unwrap();
        let turn = run_symon_text_turn_with(None, "terminal-fallback".into(), "turn-1".into(),
            "Hello".into(), "codex".into(), "gpt-6.1-sol".into(), "high".into(), true);
        let control = async {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !ready.exists() && std::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            if interrupted {
                assert!(interrupt_symon_text_turn("terminal-fallback", "turn-1"));
            }
            std::fs::write(&release, "release").unwrap();
            assert!(ready.exists(), "fixture must reach the compatibility transport");
        };
        let (result, ()) = tokio::join!(turn, control);
        let wire = serde_json::to_value(result.unwrap()).unwrap();
        assert_eq!(wire["status"], if interrupted { "interrupted" } else { "error" });
        assert_eq!(wire["model"], "gpt-5.6-sol");
        assert_eq!(wire["effort"], "high");
        assert!(wire["detail"].as_str().unwrap().contains("fixture failure"));
    }
}
