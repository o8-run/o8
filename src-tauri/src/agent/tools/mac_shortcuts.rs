//! Shortcuts tools — list (ReadOnly) / run (Destructive). `shortcuts` CLI, no
//! osascript. Ported from aqua/Symon to o8's `Result<Value, String>`.

use serde_json::{json, Value};

pub async fn list(_args: Value) -> Result<Value, String> {
    let output = tokio::task::spawn_blocking(|| {
        crate::child_environment::command("shortcuts").args(["list"]).output()
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
    .map_err(|e| format!("shortcuts list failed: {e}"))?;

    if output.status.success() {
        let names: Vec<Value> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| json!(l.trim()))
            .collect();
        Ok(json!({ "shortcuts": names }))
    } else {
        Err(format!(
            "shortcuts list error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

pub async fn run(args: Value) -> Result<Value, String> {
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("name is required".into());
    }
    let input = args.get("input").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let name_c = name.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = crate::child_environment::command("shortcuts");
        // `run <name>` takes name as a separate argv (no shell), so it can't inject.
        cmd.args(["run", &name_c]);
        if !input.is_empty() {
            cmd.args(["--input", &input]);
        }
        cmd.output()
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))?
    .map_err(|e| format!("shortcuts run failed: {e}"))?;

    if output.status.success() {
        Ok(json!({
            "success": true,
            "name": name,
            "output": String::from_utf8_lossy(&output.stdout).trim(),
        }))
    } else {
        Err(format!(
            "shortcuts run error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
