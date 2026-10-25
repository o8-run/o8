//! Symon voice-agent text planner backed by the Codex subscription CLI.
//!
//! ## Process shape (#2155)
//! Turn 1 boots ONE resident `codex app-server --stdio` child and keeps it for
//! the whole task: `initialize` → `thread/start` → one `turn/start` per planner
//! turn, so turn 2+ pays no process start. (The Claude planner has held a
//! resident stream-json child since #1252; this closes the same gap on the
//! Codex side, where every turn used to cold-spawn `codex exec`.)
//!
//! The child runs against the operator's OWN `CODEX_HOME` — o8 never copies or
//! relinks their Codex credentials, because a second copy of an OAuth token is
//! a second thing to leak and token refreshes would land in the copy instead of
//! the real file. `app-server` takes no `--ignore-user-config`, so inheritance
//! is neutralized with `-c` overrides instead (verified against codex-cli
//! 0.153.4 by reading the effective config back through `config/read`):
//!
//! * `model` / `model_reasoning_effort` / `approval_policy` / `sandbox_mode`
//!   and `tools.image_generation` are fully overridden — an operator config
//!   pinning a frontier model at `danger-full-access` reads back as this seat
//!   at `read-only` with no network.
//! * `--disable plugins --disable apps` keeps plugin-provided MCP servers out
//!   of the seat.
//! * Each MCP server declared in the operator's `config.toml` is switched off
//!   by name with `-c mcp_servers.<name>.enabled=false`, so the planner session
//!   starts no MCP children at all. `-c mcp_servers={}` is kept ahead of them
//!   as a cheap belt for other CLI builds, but on 0.153.4 it is a no-op: the
//!   override merges into the table rather than replacing it. The per-name
//!   disable is what actually works, and it only works for a server the config
//!   file really declares — naming one it does not makes the CLI reject its own
//!   bootstrap, which is why the names are read from that file rather than
//!   guessed.
//!
//! `codex exec` stays as the fallback. `app-server` is flagged experimental, so
//! if the handshake fails (an older CLI, a protocol change) the session
//! degrades to the previous per-turn `codex exec` / `exec resume` spawn instead
//! of failing the task.

use super::{claude::TextPlannerSession, ConfirmCorrelation, LoopResult, TaskCtx};
use super::text_turn::EffectiveTextSelection;
use base64::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

const APP_SERVER_CLIENT_NAME: &str = "o8-symon-planner";

pub(crate) struct CodexSession {
    binary: String,
    model: String,
    effort: String,
    /// Live app-server child. `None` before the first turn and after a boot
    /// failure has dropped this session onto the `codex exec` fallback.
    resident: Option<AppServerSession>,
    /// Boot is attempted exactly once per session; a failure is not retried on
    /// every turn.
    resident_attempted: bool,
    /// `codex exec` fallback thread id, used by `exec resume`.
    thread_id: Option<String>,
    allow_default_fallback: bool,
    progressed: bool,
    effective_selection: Option<EffectiveTextSelection>,
}

impl CodexSession {
    pub(crate) fn new(binary: &str, model: &str, effort: &str) -> Self {
        Self {
            binary: binary.to_string(),
            model: model.to_string(),
            effort: effort.to_string(),
            resident: None,
            resident_attempted: false,
            thread_id: None,
            allow_default_fallback: false,
            progressed: false,
            effective_selection: None,
        }
    }

    pub(crate) fn with_default_fallback(mut self, allowed: bool) -> Self {
        self.allow_default_fallback = allowed;
        self
    }

    pub(crate) fn observe_selection(mut self, selection: EffectiveTextSelection) -> Self {
        self.effective_selection = Some(selection);
        self
    }

    fn image_path(image_b64: Option<&str>) -> Result<Option<PathBuf>, String> {
        let Some(encoded) = image_b64 else {
            return Ok(None);
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("codex planner image decode failed: {error}"))?;
        let path = std::env::temp_dir().join(format!(
            "o8-symon-codex-{}-{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&path, bytes)
            .map_err(|error| format!("codex planner image write failed: {error}"))?;
        Ok(Some(path))
    }

    fn parse_output(&mut self, stdout: &str) -> Result<String, String> {
        let mut answer = String::new();
        for line in stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let Ok(event) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match event.get("type").and_then(Value::as_str) {
                Some("thread.started") => {
                    if let Some(thread_id) = event.get("thread_id").and_then(Value::as_str) {
                        self.thread_id = Some(thread_id.to_string());
                    }
                }
                Some("item.completed") => {
                    let item = event.get("item").unwrap_or(&Value::Null);
                    if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            answer = text.to_string();
                        }
                    }
                }
                Some("event_msg") => {
                    let payload = event.get("payload").unwrap_or(&Value::Null);
                    if payload.get("type").and_then(Value::as_str) == Some("agent_message") {
                        if let Some(text) = payload.get("message").and_then(Value::as_str) {
                            answer = text.to_string();
                        }
                    }
                }
                _ => {}
            }
        }
        if self.thread_id.is_none() {
            return Err("codex planner produced no thread id".to_string());
        }
        if answer.trim().is_empty() {
            return Err("codex planner produced no answer".to_string());
        }
        Ok(answer)
    }

    fn send_turn(&mut self, prompt: &str, image_b64: Option<&str>) -> Result<String, String> {
        // Eligibility is consumed before the first attempt. A later tool-result turn
        // or a pinned/bound session must never switch models or replay execution.
        let allowed = std::mem::take(&mut self.allow_default_fallback);
        let result = self.send_turn_once(prompt, image_b64);
        if allowed
            && !self.progressed
            && result
                .as_ref()
                .err()
                .is_some_and(|error| is_sol_unsupported(&self.model, error))
        {
            self.resident = None;
            self.resident_attempted = false;
            self.thread_id = None;
            self.model = crate::models::CODEX_GPT_5_6_SOL.to_string();
            // Publish before entering the retry: even its error or timeout must
            // leave the bound surface on the effective selection.
            if let Some(selection) = &self.effective_selection {
                selection.bind(&self.model, &self.effort);
            }
            let prompt = format!("{prompt}\n\n[SYSTEM] Your effective model is {} at {} effort. The automatic GPT-6.1 Sol default was rejected before execution; this session uses GPT-5.6 Sol. Report this accurately if asked.", self.model, self.effort);
            return self.send_turn_once(&prompt, image_b64);
        }
        result
    }

    fn send_turn_once(&mut self, prompt: &str, image_b64: Option<&str>) -> Result<String, String> {
        if !self.resident_attempted {
            self.resident_attempted = true;
            match AppServerSession::start(&self.binary, &self.model, &self.effort) {
                Ok(session) => {
                    log::info!(
                        "[symon-agent] codex planner resident on {} (effort {})",
                        self.model,
                        self.effort
                    );
                    self.resident = Some(session);
                }
                Err(error) if is_sol_unsupported(&self.model, &error) => return Err(error),
                Err(error) => log::warn!(
                    "[symon-agent] codex app-server unavailable ({error}) — falling back to per-turn exec"
                ),
            }
        }
        let image_path = Self::image_path(image_b64)?;
        let result = match self.resident.as_mut() {
            Some(session) => {
                let turn = session.send_turn(prompt, image_path.as_deref());
                self.progressed |= session.progressed;
                if turn.is_err() {
                    // A broken child is dropped (its Drop kills the proc) so a
                    // later turn re-boots or falls back instead of writing into
                    // a dead pipe.
                    self.resident = None;
                }
                turn
            }
            None => self.send_turn_exec(prompt, image_path.as_deref()),
        };
        if let Some(path) = image_path {
            let _ = std::fs::remove_file(path);
        }
        result
    }

    /// Per-turn `codex exec` spawn — the pre-#2155 shape, kept as the fallback
    /// for CLIs whose `app-server` handshake does not come up.
    fn send_turn_exec(
        &mut self,
        prompt: &str,
        image_path: Option<&std::path::Path>,
    ) -> Result<String, String> {
        let mut args = vec!["exec".to_string()];
        if let Some(thread_id) = &self.thread_id {
            args.extend(["resume".to_string(), thread_id.clone()]);
        }
        args.extend([
            "--json".to_string(),
            "-c".to_string(),
            "sandbox_mode=read-only".to_string(),
            "-c".to_string(),
            format!("model={}", self.model),
            "-c".to_string(),
            format!("model_reasoning_effort={}", self.effort),
            "-c".to_string(),
            "tools.image_generation=false".to_string(),
            "--ignore-user-config".to_string(),
        ]);
        // Every planner process runs from the system temp directory. The first
        // process starts the Codex thread, while later tool-result turns use
        // `exec resume`; both commands enforce repository trust independently.
        args.push("--skip-git-repo-check".to_string());
        if let Some(path) = image_path {
            args.extend(["--image".to_string(), path.to_string_lossy().to_string()]);
        }
        args.extend(["--".to_string(), prompt.to_string()]);

        let output = super::subscription_child::codex_exec(
            &self.binary, &super::claude::path_with_node_runtime(), &args,
        )
            .output()
            .map_err(|error| format!("codex planner spawn failed: {error}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Thread/turn receipts and terminal errors alone are not execution.
        // Every item (including reasoning/tools) or unrecognized output closes retry.
        let mut diagnostics = String::new();
        for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
            let event = serde_json::from_str::<Value>(line).unwrap_or(Value::Null);
            if matches!(
                event.get("type").and_then(Value::as_str),
                Some("error" | "turn.failed")
            ) {
                if let Some(message) = event
                    .get("message")
                    .or_else(|| event.pointer("/error/message"))
                    .and_then(Value::as_str)
                {
                    diagnostics.push_str(message);
                }
            }
            if !matches!(
                event.get("type").and_then(Value::as_str),
                Some("thread.started" | "turn.started" | "error" | "turn.failed")
            ) {
                self.progressed = true;
            }
        }
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "codex planner exited {}: {}",
                output.status.code().unwrap_or(-1),
                format!("{} {}", stderr.trim(), diagnostics)
                    .chars()
                    .take(1000)
                    .collect::<String>()
            ));
        }
        self.parse_output(&stdout)
    }
}

// Same narrow rejection contract as src/lib/codex/model-compatibility.ts.
fn is_sol_unsupported(model: &str, diagnostic: &str) -> bool {
    if model != crate::models::CODEX_GPT_6_1_SOL {
        return false;
    }
    let diagnostic = diagnostic
        .to_lowercase()
        .replace("\\\"", "'")
        .replace('"', "'");
    diagnostic.contains(
        "the 'gpt-6.1-sol' model is not supported when using codex with a chatgpt account.",
    )
}

/// Names of the MCP servers the operator's `config.toml` declares, read from
/// their own Codex home. Only the file's own names are returned, because
/// `-c mcp_servers.<name>.enabled=false` for a server the file does not declare
/// creates a transport-less entry and the CLI refuses to boot on it.
///
/// Deliberately a section-header scan rather than a TOML parse: this reads a
/// config o8 does not own, and the only thing it needs is which `[mcp_servers.x]`
/// tables exist. Bare keys only — a quoted name would need quoting inside the
/// dotted override path, and getting that wrong costs a boot. A miss here is a
/// failed handshake at worst, which drops the session onto the `exec` fallback.
fn config_mcp_server_names() -> Vec<String> {
    let home = match std::env::var("CODEX_HOME") {
        Ok(home) if !home.trim().is_empty() => PathBuf::from(home),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".codex"),
    };
    let Ok(config) = std::fs::read_to_string(home.join("config.toml")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for line in config.lines().map(str::trim) {
        let Some(rest) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .and_then(|rest| rest.strip_prefix("mcp_servers."))
        else {
            continue;
        };
        let name = rest.split('.').next().unwrap_or_default();
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        if !names.iter().any(|seen| seen == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// A LIVE `codex app-server` child held across a task's turns. NDJSON JSON-RPC
/// over stdio: one `turn/start` request per planner turn, pumped until this
/// thread's `turn/completed` notification arrives.
struct AppServerSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    reader: std::io::BufReader<std::process::ChildStdout>,
    thread_id: String,
    next_id: u64,
    progressed: bool,
}

impl AppServerSession {
    /// Config overrides that pin the seat over whatever the operator's own
    /// `config.toml` says. `model` and `effort` are `planner_route`'s
    /// allow-listed catalog constants, never free text.
    fn override_args(model: &str, effort: &str) -> Vec<String> {
        let mut args = vec![
            "app-server".to_string(),
            "--stdio".to_string(),
            "-c".to_string(),
            format!("model=\"{model}\""),
            "-c".to_string(),
            format!("model_reasoning_effort=\"{effort}\""),
            "-c".to_string(),
            "approval_policy=\"never\"".to_string(),
            "-c".to_string(),
            "sandbox_mode=\"read-only\"".to_string(),
            "-c".to_string(),
            "tools.image_generation=false".to_string(),
            "-c".to_string(),
            "mcp_servers={}".to_string(),
            // Plugin-provided MCP servers are not planner tools.
            "--disable".to_string(),
            "plugins".to_string(),
            "--disable".to_string(),
            "apps".to_string(),
        ];
        // …and the config-declared ones are switched off by name, which is the
        // override the CLI actually honors.
        for name in config_mcp_server_names() {
            args.push("-c".to_string());
            args.push(format!("mcp_servers.{name}.enabled=false"));
        }
        args
    }

    fn start(binary: &str, model: &str, effort: &str) -> Result<Self, String> {
        let mut child = super::subscription_child::codex_app_server(
            binary, &super::claude::path_with_node_runtime(), &Self::override_args(model, effort),
        )
            .spawn()
            .map_err(|error| format!("codex app-server spawn failed: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or("codex app-server: no stdin handle")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("codex app-server: no stdout handle")?;
        let mut session = Self {
            child,
            stdin,
            reader: std::io::BufReader::new(stdout),
            thread_id: String::new(),
            next_id: 1,
            progressed: false,
        };
        session.request(
            "initialize",
            json!({
                "clientInfo": { "name": APP_SERVER_CLIENT_NAME, "version": "1" },
            }),
        )?;
        session.write(json!({ "method": "initialized", "params": {} }))?;
        let started = session.request(
            "thread/start",
            json!({
                "model": model,
                "cwd": std::env::temp_dir().to_string_lossy(),
                "approvalPolicy": "never",
                "config": {
                    "model_reasoning_effort": effort,
                    "sandbox_mode": "read-only",
                },
            }),
        )?;
        let thread_id = started
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("codex app-server returned no thread id")?;
        session.thread_id = thread_id.to_string();
        Ok(session)
    }

    fn write(&mut self, message: Value) -> Result<(), String> {
        writeln!(self.stdin, "{message}")
            .map_err(|error| format!("codex app-server stdin write: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("codex app-server stdin flush: {error}"))
    }

    /// Read stdout until `visit` claims a message. Server→client requests are
    /// refused inline (the planner grants no approvals) so an unanswered
    /// request can never wedge the turn.
    fn pump<T>(
        &mut self,
        mut visit: impl FnMut(&Value) -> Option<Result<T, String>>,
    ) -> Result<T, String> {
        let mut line = String::new();
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => return Err("codex app-server exited".to_string()),
                Ok(_) => {}
                Err(error) => return Err(format!("codex app-server read: {error}")),
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                self.progressed = true;
                continue;
            };
            if let Some(outcome) = visit(&message) {
                return outcome;
            }
            let is_server_request = message.get("id").is_some()
                && message.get("method").is_some()
                && message.get("result").is_none()
                && message.get("error").is_none();
            if is_server_request {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                self.write(json!({
                    "id": id,
                    "error": { "code": -32601, "message": "the Symon planner grants no approvals" },
                }))?;
            }
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({ "id": id, "method": method, "params": params }))?;
        self.pump(|message| {
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                return None;
            }
            if let Some(error) = message.get("error") {
                return Some(Err(format!("codex app-server {method}: {error}")));
            }
            message.get("result").map(|result| Ok(result.clone()))
        })
    }

    fn send_turn(
        &mut self,
        prompt: &str,
        image_path: Option<&std::path::Path>,
    ) -> Result<String, String> {
        let mut input = vec![json!({ "type": "text", "text": prompt })];
        if let Some(path) = image_path {
            input.push(json!({ "type": "localImage", "path": path.to_string_lossy() }));
        }
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({
            "id": id,
            "method": "turn/start",
            "params": { "threadId": self.thread_id, "input": input },
        }))?;
        let mut answer = String::new();
        let mut progressed = self.progressed;
        let result = self.pump(|message| {
            if message
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|method| {
                    method.starts_with("item/")
                        || method.starts_with("codex/event/")
                        || message.get("id").is_some()
                })
            {
                progressed = true;
            }
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Some(Err(format!("codex app-server turn/start: {error}")));
                }
                return None;
            }
            match message.get("method").and_then(Value::as_str) {
                Some("item/completed") => {
                    let item = message.pointer("/params/item").unwrap_or(&Value::Null);
                    if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            answer = text.to_string();
                        }
                    }
                    None
                }
                Some("turn/completed") => {
                    if let Some(error) = message
                        .pointer("/params/turn/error")
                        .filter(|v| !v.is_null())
                    {
                        Some(Err(format!("codex app-server turn failed: {error}")))
                    } else {
                        Some(Ok(()))
                    }
                }
                Some("error") => Some(Err(format!(
                    "codex app-server error: {}",
                    message.get("params").unwrap_or(&Value::Null)
                ))),
                _ => None,
            }
        });
        self.progressed |= progressed;
        result?;
        if answer.trim().is_empty() {
            return Err("codex planner produced no answer".to_string());
        }
        Ok(answer)
    }
}

impl Drop for AppServerSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl TextPlannerSession for CodexSession {
    fn effective_model(&self) -> Option<&str> {
        Some(&self.model)
    }
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
    model: &str,
    effort: &str,
    intent: &str,
    ctx: &TaskCtx,
) -> Result<LoopResult, String> {
    super::claude::run_text_planner_loop(
        CodexSession::new(binary, model, effort),
        model,
        intent,
        ctx,
        "codex",
    )
    .await
}

pub async fn run_phone_text_loop(
    binary: &str,
    model: &str,
    effort: &str,
    intent: &str,
    ctx: &TaskCtx,
    correlation: ConfirmCorrelation,
    allow_default_fallback: bool,
    effective_selection: EffectiveTextSelection,
) -> Result<LoopResult, String> {
    super::claude::run_text_planner_loop_correlated(
        CodexSession::new(binary, model, effort)
            .with_default_fallback(allow_default_fallback)
            .observe_selection(effective_selection),
        model,
        intent,
        ctx,
        "codex",
        correlation,
    )
    .await
}

#[cfg(test)]
#[path = "codex_tests.rs"]
pub(crate) mod tests;
