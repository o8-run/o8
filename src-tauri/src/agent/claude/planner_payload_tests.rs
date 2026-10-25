//! Real-path coverage for the planner's first-turn payload (#2157).
//!
//! The payload is only worth what the planner can still do with it, so these
//! drive the loop a real escalation drives — a spawned planner process, a real
//! `tool_lookup` round trip, a real second turn — rather than asserting on the
//! builder alone.

use super::*;
use crate::agent::{claude, opencode, tools, TaskCtx};
use serde_json::json;
use std::sync::Arc;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// A throwaway data dir, so nothing in `~/.o8` is read or written while the
/// prompt builder asks for the operator's skill and memory context.
struct PayloadFixture {
    dir: std::path::PathBuf,
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl PayloadFixture {
    fn new(name: &str) -> Self {
        let guard = crate::DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "o8-planner-payload-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let previous = ["O8_DATA_DIR", "CORTEX_IDE_DATA_DIR", "SEAT_CAPTURE"]
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect();
        std::env::set_var("O8_DATA_DIR", &dir);
        std::env::remove_var("CORTEX_IDE_DATA_DIR");
        std::env::set_var("SEAT_CAPTURE", dir.join("capture"));
        Self {
            dir,
            previous,
            _guard: guard,
        }
    }
}

impl Drop for PayloadFixture {
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

fn ctx_for(task_id: &str) -> TaskCtx {
    TaskCtx {
        task_id: task_id.into(),
        utterance: "handled by the planner".into(),
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

fn ctx_with_screen(task_id: &str) -> TaskCtx {
    let mut ctx = ctx_for(task_id);
    ctx.screen = Some(std::sync::Arc::new(crate::agent::screen::ScreenContext {
        trace_id: 7,
        png_base64: "iVBORw0KGgo=".into(),
        img_w: 1512,
        img_h: 982,
        mon_x: 0.0,
        mon_y: 0.0,
        mon_w: 1512.0,
        mon_h: 982.0,
        ax_catalog: Vec::new(),
        web_catalog: Vec::new(),
    }));
    ctx
}

/// The whole point of the ordering: the bytes ahead of the task are the same
/// bytes on every escalation, so a provider prompt cache has something to hit.
/// Two tasks with different requests AND different per-task context must agree
/// byte for byte up to the first per-task character.
#[test]
fn the_invariant_prefix_is_byte_identical_across_two_tasks() {
    let _fixture = PayloadFixture::new("prefix");
    let (prefix, tool_defs) = invariant_prefix();
    assert!(tool_defs > 0, "some schemas ride the first turn");

    let plain = build_first_prompt(
        "remind me to call the bank at four",
        &ctx_for("claude-task-a"),
    );
    let with_screen = build_first_prompt(
        "what is this error on my screen",
        &ctx_with_screen("claude-task-b"),
    );

    assert!(plain.prompt.starts_with(&prefix));
    assert!(with_screen.prompt.starts_with(&prefix));
    assert_eq!(plain.prompt[..prefix.len()], with_screen.prompt[..prefix.len()]);
    assert_eq!(plain.tool_defs, with_screen.tool_defs);

    // Nothing per-task may sit inside the prefix — a clock is the one that
    // would silently break every cache hit.
    assert!(
        !prefix.contains("The current local time is"),
        "the clock belongs after the prefix"
    );
    assert!(!prefix.contains("claude-task-a"));
    assert!(
        plain.prompt[prefix.len()..].starts_with("\n\n--- RIGHT NOW ---"),
        "the per-task half starts exactly where the invariant half ends"
    );
    assert!(plain.prompt.contains("The current local time is"));

    // ...and the order is the contracted one, with the request strictly last.
    let at = |needle: &str| plain.prompt.find(needle).expect(needle);
    assert!(at("--- HOW YOU ACT ---") < at("--- TOOLS ---"));
    assert!(at("--- TOOLS ---") < at("--- RIGHT NOW ---"));
    assert!(at("--- RIGHT NOW ---") < at("\n\nUser request: "));
    assert!(plain
        .prompt
        .ends_with("\n\nUser request: remind me to call the bank at four"));
    // The screen protocol still rides the turn that carries a screenshot.
    assert!(with_screen.prompt.contains("[POINT]"));
}

/// Every tool stays reachable: the compact catalog names them all, and the
/// tools whose full schema did not ride along are one lookup away.
#[test]
fn the_compact_catalog_names_every_tool_and_only_the_allow_list_carries_a_schema() {
    let _fixture = PayloadFixture::new("catalog");
    let catalog = catalog_tools();
    let built = build_first_prompt("do the thing", &ctx_for("claude-task-c"));

    assert!(
        !catalog.is_empty() && catalog.len() > UP_FRONT_FULL_SCHEMA.len(),
        "the catalog is bigger than the allow list, or this measures nothing"
    );
    for tool in &catalog {
        let name = tool.get("name").and_then(|n| n.as_str()).unwrap();
        assert!(
            built.prompt.contains(&format!("\n{name} — ")),
            "{name} is missing from the compact catalog"
        );
    }
    assert!(
        !built.prompt.contains("\nescalate — "),
        "the background brain does the work; re-escalating is the handoff loop"
    );
    // The allow list rides as full JSON Schema; nothing else does.
    for name in UP_FRONT_FULL_SCHEMA {
        assert!(
            built.prompt.contains(&format!("\"name\":\"{name}\"")),
            "{name} should carry its full schema up front"
        );
    }
    assert_eq!(built.tool_defs, UP_FRONT_FULL_SCHEMA.len());
    assert!(
        !built.prompt.contains("\"name\":\"mac_notes_create\""),
        "a tool outside the allow list must not ship its schema"
    );
    // Deterministic order — sorted by name, so the prefix cannot shuffle.
    let names: Vec<&str> = catalog
        .iter()
        .map(|t| t.get("name").and_then(|n| n.as_str()).unwrap())
        .collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted);
}

/// A lookup answers with the exact schema, a miss says so, and the budget
/// runs out rather than letting the planner read forever.
#[test]
fn a_lookup_returns_the_exact_schema_and_names_a_miss() {
    let _fixture = PayloadFixture::new("lookup");
    let message = tool_lookup_message(&["mac_notes_create".to_string(), "not_a_tool".to_string()]);
    assert!(message.contains("\"name\":\"mac_notes_create\""));
    assert!(message.contains("\"parameters\""));
    assert!(message.contains("Not in the catalog"));
    assert!(message.contains("not_a_tool"));
    assert!(message.contains("your NEXT action"));

    // Both spellings a model reaches for.
    assert_eq!(
        requested_lookup_names(&json!({ "names": ["mac_weather"] })),
        vec!["mac_weather".to_string()]
    );
    assert_eq!(
        requested_lookup_names(&json!({ "name": "mac_weather" })),
        vec!["mac_weather".to_string()]
    );
    assert!(requested_lookup_names(&json!({})).is_empty());
    assert!(lookup_budget_spent_message().contains("tool_lookup turns"));
}

/// The real path: `escalate` hands the task to the background brain, and the
/// loop that brain runs spawns a planner process, sends the first turn, answers
/// a `tool_lookup` with the full schema, and keeps going to a finished task.
/// The one seam these two halves meet at is the desktop handle the handoff
/// needs, which a headless test cannot hold.
#[cfg(unix)]
#[tokio::test]
async fn escalate_hands_off_and_the_planner_loop_serves_a_lookup_and_continues() {
    let fixture = PayloadFixture::new("realpath");
    let ctx = ctx_for("claude-task-realpath");

    // Leg 1 — the dispatch really does route to the background brain, stopping
    // only at the desktop handle `spawn_background_brain_task` needs.
    let handed_off = tools::dispatch_tool_call(
        "escalate",
        json!({ "task": "file this week's notes", "target": "claude_brain" }),
        &ctx,
    )
    .await;
    assert_eq!(
        handed_off.unwrap_err(),
        "This action requires the live o8 desktop app"
    );

    // Leg 2 — the loop that background task runs, against a real process. The
    // fixture answers turn 1 with a lookup for a tool whose schema is NOT in
    // the first turn, then finishes.
    let planner = fixture.dir.join("opencode-fixture");
    std::fs::write(
        &planner,
        r#"#!/bin/sh
SEAT_CAPTURE="$(dirname "$0")/capture"
SEAT_COUNT="$(dirname "$0")/count"
n=$(cat "$SEAT_COUNT" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s' "$n" > "$SEAT_COUNT"
for arg in "$@"; do last="$arg"; done
printf '%s' "$last" > "$SEAT_CAPTURE.prompt.$n"
if [ "$n" = "1" ]; then
  printf '%s\n' '{"type":"text","sessionID":"ses_fixture","part":{"type":"text","text":"{\"tool\":\"tool_lookup\",\"args\":{\"names\":[\"mac_notes_create\"]}}"}}'
else
  printf '%s\n' '{"type":"text","sessionID":"ses_fixture","part":{"type":"text","text":"{\"done\":true,\"say\":\"Filed them.\"}"}}'
fi
"#,
    )
    .unwrap();
    std::fs::set_permissions(&planner, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("SEAT_COUNT", fixture.dir.join("count"));

    let session = opencode::OpencodeSession::new(&planner.to_string_lossy(), None);
    let result = claude::run_text_planner_loop(
        session,
        "opencode",
        "file this week's notes",
        &ctx,
        "opencode",
    )
    .await
    .expect("the planner loop runs to a finished task");
    std::env::remove_var("SEAT_COUNT");
    assert_eq!(
        result.result_text, "Filed them.",
        "the loop continued past the lookup"
    );

    // The prompt is the last argument of each spawn — the fixture writes it
    // out whole, so these are the exact bytes the planner received.
    let prompt_of = |turn: usize| {
        std::fs::read_to_string(format!(
            "{}.prompt.{turn}",
            fixture.dir.join("capture").display()
        ))
        .expect("the fixture recorded the prompt it was sent")
    };

    // Turn 1 as actually sent: compact catalog, allow-listed schemas only.
    let first = prompt_of(1);
    assert!(first.contains("--- TOOLS ---"));
    assert!(first.contains("\nmac_notes_create — "));
    assert!(!first.contains("\"name\":\"mac_notes_create\""));
    for name in UP_FRONT_FULL_SCHEMA {
        assert!(first.contains(&format!("\"name\":\"{name}\"")));
    }

    // Turn 2 is the lookup answer — the exact schema the planner asked for.
    let second = prompt_of(2);
    assert!(second.contains("tool_lookup returned the full JSON Schema"));
    assert!(second.contains("\"name\":\"mac_notes_create\""));
    assert!(second.contains("\"parameters\""));
}

/// The reduction itself, measured on the payload a scripted escalation sends.
///
/// `pre_2157_shape` is the builder this PR replaced, kept verbatim so the
/// before number is measured from the same live inputs rather than quoted from
/// a PR, and so the win cannot quietly erode: the acceptance bar from #2157 is
/// half, and it is asserted here per fixture.
fn pre_2157_shape(intent: &str, ctx: &TaskCtx) -> String {
    let mut s = crate::agent::system_prompt();
    if let Some(convo) = crate::agent::conversation_context() {
        s.push_str("\n\n");
        s.push_str(&convo);
    }
    if let Some(edit) = &ctx.edit {
        s.push_str("\n\n");
        s.push_str(&crate::agent::edit_prompt_section(edit));
    }
    if let Some(screen) = &ctx.screen {
        s.push_str("\n\n");
        s.push_str(&crate::agent::screen_prompt_section(screen));
        s.push_str(
            "\n\n(You CAN see the attached screenshot. When you point or draw, put the \
             [POINT]/[GUIDE]/[DRAW] tags INSIDE the \"say\" string of your final \
             {\"done\": true, \"say\": \"...\"} action — never outside the JSON object.)",
        );
    }
    let tool_specs: Vec<serde_json::Value> = crate::agent::tools::enabled_tools()
        .into_iter()
        .filter(|t| t.get("name").and_then(|n| n.as_str()) != Some("escalate"))
        .collect();
    let tools_json =
        serde_json::to_string_pretty(&tool_specs).unwrap_or_else(|_| "[]".to_string());
    s.push_str(super::super::PLANNER_CONTRACT);
    s.push_str(&format!("\n\nAVAILABLE TOOLS (JSON Schema):\n{tools_json}"));
    s.push_str(&format!("\n\nUser request: {intent}"));
    s
}

#[test]
fn the_first_turn_payload_is_at_least_half_off() {
    let _fixture = PayloadFixture::new("measure");
    let catalog = catalog_tools().len();
    for (label, ctx, intent) in [
        (
            "reminder",
            ctx_for("claude-task-m1"),
            "remind me to call the bank at four",
        ),
        (
            "fleet",
            ctx_for("claude-task-m2"),
            "what are the agents shipping right now",
        ),
        (
            "screen",
            ctx_with_screen("claude-task-m3"),
            "what is this error on my screen",
        ),
    ] {
        let before = pre_2157_shape(intent, &ctx);
        let after = build_first_prompt(intent, &ctx);
        println!(
            "[measure] fixture={label} before_bytes={} before_tool_defs={} \
             after_bytes={} after_tool_defs={} catalog_tools={}",
            before.len(),
            catalog,
            after.prompt.len(),
            after.tool_defs,
            catalog
        );
        assert!(
            after.prompt.len() * 2 < before.len(),
            "{label}: {} bytes is not at least half off {}",
            after.prompt.len(),
            before.len()
        );
    }
}
