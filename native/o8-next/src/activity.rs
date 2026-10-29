//! Display-only tool rows. Shell text is never executed.
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Step {
    pub id: String,
    pub command: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub group: usize,
    #[serde(skip)]
    pub group_key: String,
    /// The file, folder, pattern or address the step worked on, for the trace's chips.
    #[serde(skip)]
    pub subject: Option<String>,
}

fn words(text: &str, depth: usize) -> Vec<String> {
    if depth > 6 {
        return vec![];
    }
    let mut parts = Vec::new();
    let mut part = Vec::new();
    let mut word = String::new();
    let mut quote = '\0';
    let mut piped = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && quote != '\'' && chars.peek().is_some() {
            word.push(chars.next().unwrap());
        } else if quote != '\0' {
            if c == quote {
                quote = '\0';
            } else {
                word.push(c);
            }
        } else if c == '\'' || c == '"' {
            quote = c;
        } else if c == ';' || c == '\n' || c == '|' || c == '&' && chars.peek() == Some(&'&') {
            if !word.is_empty() {
                part.push(std::mem::take(&mut word));
            }
            if !part.is_empty() {
                parts.push((std::mem::take(&mut part), piped));
            }
            piped = c == '|' && chars.peek() != Some(&'|');
            if chars.peek() == Some(&c) {
                chars.next();
            }
        } else if c.is_whitespace() {
            if !word.is_empty() {
                part.push(std::mem::take(&mut word));
            }
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        part.push(word);
    }
    if !part.is_empty() {
        parts.push((part, piped));
    }
    let selected = parts
        .iter()
        .rev()
        .find(|(p, piped)| {
            !piped && !matches!(p[0].as_str(), "cd" | "true" | "false" | "echo" | "printf")
        })
        .or_else(|| parts.iter().find(|(_, p)| !p));
    let mut w = selected.map(|(w, _)| w.clone()).unwrap_or_default();
    if w.first().is_some_and(|s| base(s) == "env") {
        w.remove(0);
    }
    let assignment = |s: &String| {
        s.split_once('=').is_some_and(|(k, _)| {
            !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_')
        })
    };
    while w.first().is_some_and(assignment) {
        w.remove(0);
    }
    if w.first().is_some_and(|s| s == "sudo") {
        w.remove(0);
    }
    if w.first().is_some_and(|s| base(s) == "o8") && w.get(1).is_some_and(|s| s == "run") {
        if let Some(i) = w.iter().position(|s| s == "--") {
            w = w[i + 1..].to_vec();
        }
    }
    if w.first()
        .is_some_and(|s| matches!(base(s), "sh" | "bash" | "zsh" | "dash"))
    {
        if let Some(i) = w
            .iter()
            .position(|s| s.starts_with('-') && s.ends_with('c'))
        {
            return words(&w[i + 1..].join(" "), depth + 1);
        }
    }
    while w.first().is_some_and(assignment) {
        w.remove(0);
    }
    if w.first().is_some_and(|s| base(s) == "npx") {
        w.remove(0);
        while w.first().is_some_and(|s| s.starts_with('-')) {
            w.remove(0);
        }
    }
    if w.first().is_some_and(|s| base(s) == "git") {
        let mut i = 1;
        while w.get(i).is_some_and(|s| s.starts_with('-')) {
            i += if matches!(w[i].as_str(), "-C" | "-c" | "--git-dir" | "--work-tree") {
                2
            } else {
                1
            };
        }
        w = [w[..1].to_vec(), w.get(i..).unwrap_or_default().to_vec()].concat();
    }
    w
}
fn base(text: &str) -> &str {
    text.rsplit('/').next().unwrap_or(text)
}
fn strip_shell(raw: &str) -> String {
    let mut s = raw.trim().to_owned();
    for _ in 0..4 {
        let Some((exe, rest)) = s.split_once(char::is_whitespace) else {
            break;
        };
        if !matches!(base(exe), "sh" | "bash" | "zsh" | "dash") {
            break;
        }
        let Some((flag, body)) = rest.trim_start().split_once(char::is_whitespace) else {
            break;
        };
        if !flag.starts_with('-') || !flag.ends_with('c') {
            break;
        }
        s = body.trim().to_owned();
        if s.len() > 1
            && (s.starts_with('\'') && s.ends_with('\'') || s.starts_with('"') && s.ends_with('"'))
        {
            s = s[1..s.len() - 1].to_owned();
        }
    }
    s.trim().to_owned()
}
fn group_key(exe: &str, w: &[String]) -> String {
    if matches!(
        exe,
        "cat" | "sed" | "head" | "tail" | "nl" | "less" | "read" | "read_file"
    ) {
        "read".into()
    } else if matches!(
        exe,
        "apply_patch" | "edit" | "write" | "write_file" | "edit_file" | "notebookedit"
    ) {
        "edit".into()
    } else if matches!(
        exe,
        "rg" | "grep"
            | "find"
            | "search"
            | "search_code"
            | "search_web"
            | "grep_search"
            | "websearch"
            | "web_search"
    ) || exe == "git" && w.get(1).is_some_and(|s| s == "grep")
    {
        if exe.contains("web") {
            "web-search".into()
        } else {
            "search".into()
        }
    } else if matches!(
        exe,
        "ls" | "glob" | "list" | "list_files" | "list_directory"
    ) {
        "list".into()
    } else if exe == "git"
        && w.get(1)
            .is_some_and(|s| matches!(s.as_str(), "diff" | "status" | "log"))
    {
        format!("git:{}", w[1])
    } else if matches!(exe, "vitest" | "jest" | "pytest")
        || matches!(exe, "npm" | "pnpm" | "yarn" | "bun" | "cargo")
            && w.iter()
                .skip(1)
                .any(|s| s == "test" || s.starts_with("test:"))
    {
        "test".into()
    } else if exe == "tsc"
        || w.iter()
            .any(|s| matches!(s.as_str(), "typecheck" | "type-check"))
    {
        "typecheck".into()
    } else if exe == "eslint" || w.iter().any(|s| s == "lint") {
        "lint".into()
    } else {
        format!("command:{exe}")
    }
}
pub fn activity(id: &str, tool: &Value, entry_text: &str) -> Step {
    let name = tool["name"].as_str().unwrap_or("tool");
    let name = name
        .rsplit("__")
        .next()
        .unwrap_or(name)
        .rsplit('.')
        .next()
        .unwrap_or(name)
        .to_lowercase();
    let shell = matches!(
        name.as_str(),
        "bash"
            | "shell"
            | "exec"
            | "exec_command"
            | "shell_command"
            | "run_terminal_cmd"
            | "run_user_shell_command"
            | "command_execution"
            | "terminal"
    );
    let args = &tool["args"];
    let raw = if args.is_object() {
        ["command", "cmd", "input"]
            .iter()
            .find_map(|k| args.get(*k))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::String(entry_text.into())
    };
    let raw_text = raw
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            raw.as_array().map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
        })
        .unwrap_or_default();
    let mut command = if shell {
        strip_shell(&raw_text)
    } else {
        String::new()
    };
    if command.is_empty() && shell {
        if let Some(p) = tool["preview"].as_str() {
            if let Some(c) = p
                .strip_prefix("Running ")
                .or_else(|| p.strip_prefix("Run "))
            {
                command = strip_shell(c);
            }
        }
    }
    let tokens = words(
        if shell && raw.is_string() {
            &raw_text
        } else {
            &command
        },
        0,
    );
    let exe = tokens
        .first()
        .map(|s| base(s))
        .filter(|s| !s.is_empty())
        .unwrap_or(&name);
    let key = group_key(exe, &tokens);
    if command.is_empty() {
        let path = ["file_path", "filePath", "path", "filename", "target_file"]
            .iter()
            .find_map(|k| args[*k].as_str());
        command = format!(
            "{}{}",
            tool["name"].as_str().unwrap_or("tool"),
            path.map(|p| format!(" {p}")).unwrap_or_default()
        );
    }
    let status = match tool["status"].as_str() {
        Some("error") => "failed",
        Some("stopped") => "stopped",
        Some("calling" | "running") => "running",
        _ => "ok",
    }
    .to_owned();
    let reason = if status == "failed" || status == "stopped" {
        Some(
            [
                tool["result"].as_str(),
                tool["preview"].as_str(),
                Some(entry_text),
            ]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or(if status == "stopped" {
                "Stopped"
            } else {
                "Command failed"
            })
            .into(),
        )
    } else {
        None
    };
    let subject = [
        "file_path",
        "filePath",
        "notebook_path",
        "path",
        "filename",
        "target_file",
        "pattern",
        "query",
        "url",
        "glob",
    ]
    .iter()
    .find_map(|k| args[*k].as_str())
    .filter(|s| !s.trim().is_empty())
    .map(str::to_owned);
    Step {
        id: id.into(),
        command,
        status,
        reason,
        group: 0,
        group_key: key,
        subject,
    }
}

pub fn group(steps: &mut [Step]) {
    let mut index = 0;
    for i in 0..steps.len() {
        if i > 0
            && (steps[i].status == "failed"
                || steps[i - 1].status == "failed"
                || steps[i].group_key != steps[i - 1].group_key)
        {
            index += 1;
        }
        steps[i].group = index;
    }
}

/// The desktop's counted rollup ("Explored 2 files · Ran 3 commands"); a live
/// block names the step that is still running.
pub fn summary(steps: &[Step]) -> String {
    if let Some(step) = steps.iter().rev().find(|s| s.status == "running") {
        return format!("Running {}", step.command.lines().next().unwrap_or(""));
    }
    let count = |key: &str| steps.iter().filter(|s| s.group_key == key).count();
    let (explored, edited) = (count("read"), count("edit"));
    let ran = steps.len() - explored - edited;
    let failed = steps.iter().filter(|s| s.status == "failed").count();
    let noun = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut parts = vec![];
    if explored > 0 {
        parts.push(format!("Explored {}", noun(explored, "file", "files")));
    }
    if ran > 0 {
        parts.push(format!("Ran {}", noun(ran, "command", "commands")));
    }
    if edited > 0 {
        parts.push(format!("Edited {}", noun(edited, "file", "files")));
    }
    if failed > 0 {
        parts.push(format!("{failed} failed"));
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(command: &str, key: &str, status: &str) -> Step {
        Step {
            id: command.into(),
            command: command.into(),
            status: status.into(),
            reason: None,
            group: 0,
            group_key: key.into(),
            subject: None,
        }
    }

    #[test]
    fn summary_counts_like_the_desktop_rollup() {
        let steps = [
            step("cat a.rs", "read", "ok"),
            step("sed -n 1,20p b.rs", "read", "ok"),
            step("cargo test", "test", "failed"),
            step("apply_patch", "edit", "ok"),
        ];
        assert_eq!(
            summary(&steps),
            "Explored 2 files · Ran 1 command · Edited 1 file · 1 failed"
        );
        assert_eq!(summary(&steps[..1]), "Explored 1 file");
    }

    #[test]
    fn summary_names_the_running_step() {
        let steps = [
            step("cat a.rs", "read", "ok"),
            step("cargo test\n--all", "test", "running"),
        ];
        assert_eq!(summary(&steps), "Running cargo test");
    }
}
