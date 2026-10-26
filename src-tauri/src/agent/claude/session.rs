//! Native planner process and stream transport, shared with the bounded harness.
use super::*;

/// A LIVE `claude` planner process kept open across a task's turns. Spawned once
/// (tools OFF, stream-json), it holds stdin + a persistent reader so each turn is
/// one user frame in / `result` out WITHOUT re-spawning or re-sending the system
/// prompt + tool schema — the model keeps its own context between turns (#1252
/// speed pass; replaces the old spawn-per-turn helper). The warm pool
/// (`claude_pool`) pre-boots these on the Option keydown so turn 1 skips the
/// ~1-2s CLI bootstrap. Same flags + subscription billing as before (no `--print`).
pub(crate) struct ClaudeSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    reader: std::io::BufReader<std::process::ChildStdout>,
    stderr: std::sync::mpsc::Receiver<String>,
    /// Model this proc booted for — the pool keys warm reuse on it.
    pub(crate) model: String,
}

impl ClaudeSession {
    /// Boot a `claude` proc ready to receive turns. Returns as soon as the
    /// process is started; the CLI bootstrap runs in the child (overlap it via
    /// the warm pool). stdin stays OPEN for the proc's life — closing at EOF
    /// makes the CLI run its SessionStart hooks and exit without processing.
    pub(crate) fn spawn(bin: &str, model: &str, mcp_cfg: &str) -> Result<Self, String> {
        Self::spawn_with_effort(
            bin,
            model,
            mcp_cfg,
            super::super::planner_route::claude_effort_flag(model),
        )
    }

    pub(crate) fn spawn_with_effort(
        bin: &str,
        model: &str,
        mcp_cfg: &str,
        effort: Option<&str>,
    ) -> Result<Self, String> {
        use std::process::{Command, Stdio};
        let mut args: Vec<&str> = vec![
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "bypassPermissions",
            "--strict-mcp-config",
            "--mcp-config",
            mcp_cfg,
            // Hard tool lock: `""` disables EVERY built-in tool (Bash, Read,
            // Write, Edit, WebFetch, …). `--strict-mcp-config` + the empty
            // `--mcp-config` already deny MCP tools; together the proc is
            // fully tool-free. This is the enforced backstop the planner
            // contract only *asked* for: even under `bypassPermissions` a
            // model that ignores the contract has nothing to execute, so
            // Smart Compose cannot run a generated terminal command and the
            // planner cannot touch the disk. Also enforces "no repo
            // retrieval yet" — Read/Glob/Grep are gone too.
            "--tools",
            "",
            "--model",
            model,
        ];
        if let Some(effort) = effort {
            args.extend_from_slice(&["--effort", effort]);
        }
        let mut child = Command::new(bin)
            .args(&args)
            .env("FORCE_COLOR", "0")
            .env("NO_COLOR", "1")
            // npm-installed claude is a node shim — see path_with_node_runtime.
            .env("PATH", path_with_node_runtime())
            // No `--print` → draws the user's Claude subscription pool, not the
            // metered SDK pool. Scrub ANTHROPIC_API_KEY so an env key can't flip
            // billing to the API pool (it takes precedence over the sub).
            .env_remove("ANTHROPIC_API_KEY")
            .env("O8_MANAGED_SESSION", "1")
            // Neutral cwd — a project `.claude/` / `.mcp.json` would otherwise
            // bleed tools back in, defeating `--strict-mcp-config`.
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("claude spawn failed: {e}"))?;
        let stdin = child.stdin.take().ok_or("claude: no stdin handle")?;
        let stdout = child.stdout.take().ok_or("claude: no stdout handle")?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or("Worker stderr handle is unavailable.")?;
        let (diagnostics, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut tail = Vec::new();
            let mut chunk = [0; 1_024];
            while let Ok(count) = stderr.read(&mut chunk) {
                if count == 0 {
                    break;
                }
                tail.extend_from_slice(&chunk[..count]);
                if tail.len() > 4_096 {
                    tail.drain(..tail.len() - 4_096);
                }
            }
            let _ = diagnostics.send(String::from_utf8_lossy(&tail).trim().to_string());
        });
        Ok(Self {
            child,
            stdin,
            reader: std::io::BufReader::new(stdout),
            stderr: received,
            model: model.to_string(),
        })
    }

    fn failure_reason(&self, fallback: String) -> String {
        self.stderr
            .recv_timeout(Duration::from_millis(100))
            .ok()
            .filter(|detail| !detail.is_empty())
            .unwrap_or(fallback)
    }

    /// Still running? The pool discards dead warm sessions instead of handing
    /// one out (a stale CLI may have idle-exited).
    pub(crate) fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Send ONE planner turn and read stream-json until the `result` event;
    /// return its text. The proc STAYS ALIVE for the next turn (the model keeps
    /// its context, so follow-ups send only the tool result — no re-prefill). On
    /// the first turn a screenshot may ride along as an image block; later turns
    /// pass None. Blocking — call from `spawn_blocking`.
    pub(crate) fn send_turn(
        &mut self,
        prompt: &str,
        image_b64: Option<&str>,
    ) -> Result<String, String> {
        use std::io::{BufRead, Write};
        let content = match image_b64 {
            Some(b64) => json!([
                { "type": "text", "text": prompt },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": b64 } },
            ]),
            None => json!(prompt),
        };
        let frame = json!({ "type": "user", "message": { "role": "user", "content": content } });
        if let Err(error) = writeln!(self.stdin, "{frame}").and_then(|_| self.stdin.flush()) {
            return Err(self.failure_reason(format!("Worker input failed: {error}")));
        }

        let mut answer = String::new();
        let mut got_result = false;
        let mut line = String::new();
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => break, // EOF — the proc exited
                Ok(_) => {}
                Err(e) => return Err(format!("claude read: {e}")),
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(ev) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if claude_event_indicates_model_unavailable(&ev) {
                let detail = claude_event_text(&ev).unwrap_or("selected model is unavailable");
                return Err(format!("{MODEL_UNAVAILABLE_ERROR_PREFIX}{detail}"));
            }
            match ev.get("type").and_then(|t| t.as_str()) {
                Some("result") => {
                    if ev.get("is_error").and_then(Value::as_bool) == Some(true)
                        || ev
                            .get("subtype")
                            .and_then(Value::as_str)
                            .is_some_and(|value| value != "success")
                    {
                        return Err(claude_event_text(&ev)
                            .unwrap_or("Worker rejected the planner turn.")
                            .to_string());
                    }
                    answer = ev
                        .get("result")
                        .and_then(|r| r.as_str())
                        .unwrap_or("")
                        .to_string();
                    got_result = true;
                    break;
                }
                // Fallback: if the `result` text is ever empty, the last assistant
                // text block is the answer.
                Some("assistant") => {
                    if let Some(blocks) = ev.pointer("/message/content").and_then(|c| c.as_array())
                    {
                        for block in blocks {
                            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                    if !t.trim().is_empty() {
                                        answer = t.to_string();
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if !got_result && answer.trim().is_empty() {
            return Err(self.failure_reason("Worker produced no result for this turn.".to_string()));
        }
        Ok(answer)
    }
}

pub(super) fn claude_event_text(event: &Value) -> Option<&str> {
    event
        .get("result")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            event
                .get("errors")
                .and_then(Value::as_array)
                .and_then(|errors| errors.iter().find_map(Value::as_str))
        })
        .or_else(|| {
            event
                .pointer("/message/content")
                .and_then(Value::as_array)
                .and_then(|blocks| {
                    blocks.iter().find_map(|block| {
                        (block.get("type").and_then(Value::as_str) == Some("text"))
                            .then(|| block.get("text").and_then(Value::as_str))
                            .flatten()
                    })
                })
        })
}

pub(super) fn claude_event_indicates_model_unavailable(event: &Value) -> bool {
    if matches!(
        event.get("error").and_then(Value::as_str),
        Some("model_not_found" | "model_unavailable" | "model_not_available_for_org")
    ) {
        return true;
    }
    if event.get("is_error").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    if event.get("api_error_status").and_then(Value::as_u64) == Some(404) {
        return true;
    }
    let detail = claude_event_text(event)
        .unwrap_or_default()
        .to_ascii_lowercase();
    detail.contains("model not found")
        || detail.contains("model is not available")
        || detail.contains("model may not exist")
        || detail.contains("may not have access to it")
}

pub(super) fn is_model_unavailable_error(error: &str) -> bool {
    error.starts_with(MODEL_UNAVAILABLE_ERROR_PREFIX)
}

pub(super) fn should_retry_with_claude_fallback(model: &str, error: &str) -> bool {
    matches!(
        model,
        crate::models::CLAUDE_FABLE_5 | crate::models::CLAUDE_OPUS_5
    ) && error.starts_with(FIRST_TURN_MODEL_UNAVAILABLE_PREFIX)
}

impl Drop for ClaudeSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
