//! Bound phone turns keep the selected effort through process launch.
use super::*;

pub async fn run_phone_text_loop_with_binary(
    bin: &str,
    model: &str,
    effort: &str,
    intent: &str,
    ctx: &TaskCtx,
    correlation: ConfirmCorrelation,
) -> Result<LoopResult, String> {
    let mcp_cfg = ensure_empty_mcp_config()?;
    // The shared warm slot is keyed only by model. A bound effort must use
    // its own process so a default session cannot replace the phone's pin.
    let session = ClaudeSession::spawn_with_effort(bin, model, &mcp_cfg, Some(effort))?;
    run_text_planner_loop_correlated(session, model, intent, ctx, "claude", correlation).await
}
