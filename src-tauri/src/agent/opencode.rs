//! Symon voice-agent text planner backed by the opencode CLI (#2156).
//!
//! ## Why this adapter exists
//! The planner used to be hardwired to two proprietary CLIs, so a machine with
//! neither had no escalation brain at all. opencode is the first open runtime
//! on the registry seam in `planner_route`: same JSON-action protocol, same
//! `TextPlannerSession` contract, different spawn.
//!
//! ## Process shape
//! Per-turn `opencode run --format json`, resumed with `--session <id>`. There
//! is no resident-session mode in the non-interactive CLI (`run` is one message
//! in, one reply out), so the thread is carried by the session id the first
//! turn reports rather than by a held child. Verified against opencode 1.18.21:
//! every event on stdout carries `sessionID`, an assistant reply arrives as a
//! completed `{"type":"text","part":{"text":…}}` event (not a delta stream),
//! and a second `run --session <id>` continues the same thread.
//!
//! ## Seat posture
//! * `--agent plan` — opencode's read-only primary agent. The planner contract
//!   already tells the model it has no tools; this is the enforced backstop,
//!   the same posture as the Claude seat's `--tools ""` and the Codex seat's
//!   `sandbox_mode=read-only`.
//! * `--pure` — no external plugins, so a plugin-provided tool cannot join the
//!   seat. Mirrors the Codex seat's `--disable plugins`.
//! * No `--model` unless the operator pinned one: which models an opencode
//!   install can reach depends on the operator's own provider credentials, so
//!   o8 never names one for them.
//! * No `--variant`: the accepted reasoning names are per-provider and
//!   per-model, and guessing one costs the turn. `PlannerEffort::
//!   RuntimeConfigured` records that the seat runs at the operator's own
//!   setting.
//! * The child runs from the system temp dir and is never given `--auto`, so a
//!   permission prompt fails the turn rather than granting itself access.

use super::{claude::TextPlannerSession, ConfirmCorrelation, LoopResult, TaskCtx};
use base64::Engine;
use serde_json::Value;
use std::path::PathBuf;

/// opencode's read-only primary agent.
const PLANNER_AGENT: &str = "plan";

pub(crate) struct OpencodeSession {
    binary: String,
    /// Operator model pin, or `None` to run the model opencode is configured
    /// for.
    model: Option<String>,
    /// Session id reported by the first turn; every later turn resumes it.
    session_id: Option<String>,
}

impl OpencodeSession {
    pub(crate) fn new(binary: &str, model: Option<&str>) -> Self {
        Self::resuming(binary, model, None)
    }

    /// Same seat, continuing a thread this machine already opened. `resume` is
    /// an opaque `sessionID` the bound text surface held for this conversation
    /// (#2176) — the first turn of a new conversation passes `None`.
    pub(crate) fn resuming(binary: &str, model: Option<&str>, resume: Option<&str>) -> Self {
        Self {
            binary: binary.to_string(),
            model: model.map(str::to_string),
            session_id: resume
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
        }
    }

    /// The thread this session is on, for a caller that has to carry it to the
    /// next turn. This seat has no o8-side model id, so the handle IS its
    /// identity across turns.
    pub(crate) fn resume_handle(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// A screenshot rides the turn as a file attachment, so it has to land on
    /// disk first. Same shape as the Codex adapter's image handling.
    fn image_path(image_b64: Option<&str>) -> Result<Option<PathBuf>, String> {
        let Some(encoded) = image_b64 else {
            return Ok(None);
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("opencode planner image decode failed: {error}"))?;
        let path = std::env::temp_dir().join(format!(
            "o8-symon-opencode-{}-{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&path, bytes)
            .map_err(|error| format!("opencode planner image write failed: {error}"))?;
        Ok(Some(path))
    }

    /// argv for one turn. Pulled out of the spawn so a test can assert on the
    /// exact command without running the CLI.
    pub(crate) fn turn_args(&self, prompt: &str, image_path: Option<&std::path::Path>) -> Vec<String> {
        let mut args = vec![
            "run".to_string(),
            "--format".to_string(),
            "json".to_string(),
            "--pure".to_string(),
            "--agent".to_string(),
            PLANNER_AGENT.to_string(),
        ];
        if let Some(session_id) = &self.session_id {
            args.extend(["--session".to_string(), session_id.clone()]);
        }
        if let Some(model) = &self.model {
            args.extend(["--model".to_string(), model.clone()]);
        }
        if let Some(path) = image_path {
            args.extend(["--file".to_string(), path.to_string_lossy().to_string()]);
        }
        // Everything after `--` is the message, so a prompt that happens to
        // open with a dash is never read as a flag.
        args.extend(["--".to_string(), prompt.to_string()]);
        args
    }

    /// Read the NDJSON event stream: remember the session id so the next turn
    /// resumes the thread, and take the last completed text part as the reply.
    fn parse_output(&mut self, stdout: &str) -> Result<String, String> {
        let mut answer = String::new();
        for line in stdout.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let Ok(event) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if self.session_id.is_none() {
                if let Some(session_id) = event
                    .get("sessionID")
                    .or_else(|| event.pointer("/part/sessionID"))
                    .and_then(Value::as_str)
                {
                    self.session_id = Some(session_id.to_string());
                }
            }
            if event.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            if let Some(text) = event.pointer("/part/text").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    answer = text.to_string();
                }
            }
        }
        if self.session_id.is_none() {
            return Err("opencode planner produced no session id".to_string());
        }
        if answer.trim().is_empty() {
            return Err("opencode planner produced no answer".to_string());
        }
        Ok(answer)
    }

    fn send_turn(&mut self, prompt: &str, image_b64: Option<&str>) -> Result<String, String> {
        let image_path = Self::image_path(image_b64)?;
        let result = self.run_once(prompt, image_path.as_deref());
        if let Some(path) = image_path {
            let _ = std::fs::remove_file(path);
        }
        result
    }

    fn run_once(
        &mut self,
        prompt: &str,
        image_path: Option<&std::path::Path>,
    ) -> Result<String, String> {
        let output = super::subscription_child::opencode(
            &self.binary, &super::claude::path_with_node_runtime(), &self.turn_args(prompt, image_path),
        )
            .output()
            .map_err(|error| format!("opencode planner spawn failed: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "opencode planner exited {}: {}",
                output.status.code().unwrap_or(-1),
                stderr.trim().chars().take(500).collect::<String>()
            ));
        }
        self.parse_output(&String::from_utf8_lossy(&output.stdout))
    }
}

impl TextPlannerSession for OpencodeSession {
    fn send_planner_turn(
        &mut self,
        prompt: &str,
        image_b64: Option<&str>,
    ) -> Result<String, String> {
        self.send_turn(prompt, image_b64)
    }
}

pub async fn run_loop(
    binary: &str,
    model: Option<&str>,
    intent: &str,
    ctx: &TaskCtx,
) -> Result<LoopResult, String> {
    super::claude::run_text_planner_loop(
        OpencodeSession::new(binary, model),
        model.unwrap_or("opencode"),
        intent,
        ctx,
        "opencode",
    )
    .await
}

/// One bound (phone / managed-messages) turn on the open seat, continuing
/// `resume` when the conversation already opened a thread. Hands the thread it
/// ended on back to the caller so the next turn resumes the same one (#2176) —
/// this seat carries no o8-side model id, so the handle is what binds it.
pub async fn run_phone_text_loop(
    binary: &str,
    model: Option<&str>,
    resume: Option<&str>,
    intent: &str,
    ctx: &TaskCtx,
    correlation: ConfirmCorrelation,
) -> Result<(LoopResult, Option<String>), String> {
    let (result, session) = super::claude::run_text_planner_loop_correlated_resumable(
        OpencodeSession::resuming(binary, model, resume),
        model.unwrap_or("opencode"),
        intent,
        ctx,
        "opencode",
        correlation,
    )
    .await?;
    let handle = session.resume_handle().map(str::to_string);
    Ok((result, handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live shape from opencode 1.18.21, trimmed to the fields the adapter
    /// reads.
    const TURN_ONE: &str = r#"{"type":"step_start","sessionID":"ses_abc","part":{"id":"prt_1","sessionID":"ses_abc","type":"step-start"}}
{"type":"text","sessionID":"ses_abc","part":{"id":"prt_2","sessionID":"ses_abc","type":"text","text":"{\"tool\":\"mac_weather\",\"args\":{}}"}}
{"type":"step_finish","sessionID":"ses_abc","part":{"id":"prt_3","reason":"stop","type":"step-finish"}}"#;

    #[test]
    fn first_turn_opens_a_thread_and_the_next_turn_resumes_it() {
        let mut session = OpencodeSession::new("/mock/opencode", None);

        let first = session.turn_args("plan this", None);
        assert_eq!(first[0], "run");
        assert!(first.windows(2).any(|pair| pair == ["--format", "json"]));
        assert!(first.windows(2).any(|pair| pair == ["--agent", PLANNER_AGENT]));
        assert!(first.iter().any(|arg| arg == "--pure"));
        assert!(
            !first.iter().any(|arg| arg == "--session"),
            "turn 1 has no thread to resume: {first:?}"
        );
        assert!(
            !first.iter().any(|arg| arg == "--model"),
            "with no operator pin the CLI runs its own configured model: {first:?}"
        );
        assert!(
            !first.iter().any(|arg| arg == "--auto"),
            "the planner seat never auto-approves permissions: {first:?}"
        );
        assert_eq!(first[first.len() - 2], "--");
        assert_eq!(first[first.len() - 1], "plan this");

        let answer = session.parse_output(TURN_ONE).unwrap();
        assert_eq!(answer, r#"{"tool":"mac_weather","args":{}}"#);
        assert_eq!(session.session_id.as_deref(), Some("ses_abc"));

        let second = session.turn_args("[SYSTEM] You called …", None);
        let session_at = second.iter().position(|arg| arg == "--session").unwrap();
        assert_eq!(second[session_at + 1], "ses_abc");
    }

    #[test]
    fn an_operator_pin_rides_the_model_flag_and_an_image_rides_a_file_flag() {
        let session = OpencodeSession::new("/mock/opencode", Some("openrouter/some-model"));
        let args = session.turn_args("look at this", Some(std::path::Path::new("/tmp/shot.png")));
        let model_at = args.iter().position(|arg| arg == "--model").unwrap();
        assert_eq!(args[model_at + 1], "openrouter/some-model");
        let file_at = args.iter().position(|arg| arg == "--file").unwrap();
        assert_eq!(args[file_at + 1], "/tmp/shot.png");
    }

    #[test]
    fn a_stream_with_no_text_part_is_an_error_not_a_silent_empty_turn() {
        let mut session = OpencodeSession::new("/mock/opencode", None);
        let error = session
            .parse_output(r#"{"type":"step_start","sessionID":"ses_abc","part":{"id":"prt_1"}}"#)
            .unwrap_err();
        assert_eq!(error, "opencode planner produced no answer");
    }
}
