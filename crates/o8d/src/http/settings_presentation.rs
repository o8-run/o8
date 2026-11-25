//! Bounded TOML presentation projection. Other declared settings defer until their
//! validators are ported, because an invalid unrelated key invalidates the global file.
use super::ReadContext;
use serde_json::{json, Value};
use toml::{Table, Value as Toml};

#[derive(Default)]
struct Values {
    quiet: Option<bool>,
    review: Option<String>,
}
// Unknown means we cannot establish whether TS would reject a declared setting.
// Invalid means TS rejects this known field (and skips a machine layer).
enum Failure { Unknown, Invalid }
fn layer(table: &Table, global: bool) -> Result<Values, Failure> {
    let mut values = Values::default();
    for (name, value) in table {
        if global && name == "scope" { continue; }
        let section = value.as_table().ok_or(Failure::Unknown)?;
        for (field, value) in section {
            match (name.as_str(), field.as_str()) {
                ("presentation", "quiet_mode") => values.quiet = Some(value.as_bool().ok_or(Failure::Invalid)?),
                ("notifications", "review_ready") => {
                    let text = value.as_str().ok_or(Failure::Invalid)?;
                    if !matches!(text, "on" | "off") { return Err(Failure::Invalid); }
                    values.review = Some(text.to_owned());
                }
                ("operator", "heal_bot_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("operator", "supervisor_auto_escalate") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("review", "continuation_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("broadcast", "voice_attention") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("broadcast", "voice_approvals") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("broadcast", "voice_reviews") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("broadcast", "voice_failures") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("broadcast", "voice_completions") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("broadcast", "voice_calendar") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("broadcast", "voice_time_checkins") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("chat", "enter_queues") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("git", "apfs_dependency_images") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("models", "prompt_caching_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("chat", "auto_title_inference_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("inbox", "auto_settle") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("review", "merge_test_replay_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("experimental", "opencode_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("experimental", "gemini_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("experimental", "chat_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("experimental", "canvas_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("experimental", "next_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("experimental", "native_dictation_pill") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("experimental", "native_dictation_hud") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("experimental", "native_spatial_ink") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("experimental", "native_browser_view") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("orchestrator", "legacy_claude_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("brain", "use_claude_cli") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("brain", "warmup_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("judgment", "managed_option_visible") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("models", "cross_house_worker_fallback") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("orchestrator", "codex_app_threads") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("review", "buyin_doc_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("git", "commit_attribution_enabled") => { value.as_bool().ok_or(Failure::Invalid)?; }
                ("git", "worktree_max_count") => { bounded_number(value, 0.0, 1000.0, true, false)?; }
                ("git", "worktree_max_total_gb") => { bounded_number(value, 0.0, 10000.0, false, false)?; }
                ("git", "storage_reserve_ratio") => { bounded_number(value, 0.0, 1.0, false, false)?; }
                ("git", "storage_reserve_floor_gb") => { bounded_number(value, 0.0, 10000.0, false, true)?; }
                ("models", "default_dispatch_model") => { value.as_str().ok_or(Failure::Invalid)?; }
                ("local_models", "embed_model") => { value.as_str().ok_or(Failure::Invalid)?; }
                ("local_models", "chat_model") => { value.as_str().ok_or(Failure::Invalid)?; }
                ("text_generation", "title_model") => { value.as_str().ok_or(Failure::Invalid)?; }
                ("editor", "command") => { value.as_str().ok_or(Failure::Invalid)?; }
                // Removed settings that older files may still carry; the server ignores them.
                ("telemetry", _) => {}
                _ => return Err(Failure::Unknown),
            }
        }
    }
    Ok(values)
}
// JS number validators accept both TOML integer and float spellings.
fn bounded_number(value: &Toml, low: f64, high: f64, integer: bool, exclusive: bool) -> Result<(), Failure> {
    let number = value.as_integer().map(|n| n as f64).or_else(|| value.as_float()).ok_or(Failure::Invalid)?;
    if !number.is_finite() || number < low || (exclusive && number == low) || number > high
        || (integer && number.fract() != 0.0) { return Err(Failure::Invalid); }
    Ok(())
}
pub(super) fn read(store: &ReadContext<'_>) -> Result<Value, ()> {
    let bytes = store.file(&store.directory.join("settings.toml"), 8 * 1024 * 1024)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| ())?;
    let document = text.parse::<Table>().map_err(|_| ())?;
    let mut values = layer(&document, true).map_err(|_| ())?;
    let machine_id = store.defaults_context.as_ref().and_then(|c| c.get("machineId")).and_then(Value::as_str).ok_or(())?;
    if !machine_id.is_empty() && machine_id.encode_utf16().count() <= 200
        && !matches!(machine_id, "__proto__" | "constructor" | "prototype") {
        let machine = document.get("scope").and_then(Toml::as_table)
            .and_then(|s| s.get("machine")).and_then(Toml::as_table)
            .and_then(|m| m.get(machine_id)).and_then(Toml::as_table);
        if let Some(machine) = machine {
            match layer(machine, false) {
                Ok(overrides) => {
                    if overrides.quiet.is_some() { values.quiet = overrides.quiet; }
                    if overrides.review.is_some() { values.review = overrides.review; }
                }
                Err(Failure::Invalid) => {} // One invalid machine layer is skipped as a whole.
                Err(Failure::Unknown) => return Err(()),
            }
        }
    }
    Ok(json!({"values": {"presentationQuietMode": values.quiet.unwrap_or(false),
        "notificationsReviewReady": values.review.as_deref().unwrap_or("on")}}))
}
