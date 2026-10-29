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
    /// What the step did, one part per command in a chained shell line.
    #[serde(skip)]
    pub parts: Vec<Part>,
    /// Files a search matched, read from its output.
    #[serde(skip)]
    pub found: Vec<String>,
    /// The pages a web search returned, as (title, address).
    #[serde(skip)]
    pub links: Vec<(String, String)>,
    /// Tool calls that ran at the same time share a batch.
    #[serde(skip)]
    pub batch: Option<String>,
}

/// One command's worth of work, for wording the trace.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Part {
    pub key: String,
    /// The file, folder, pattern, query or address it worked on.
    pub subject: Option<String>,
    /// Where a search or listing looked.
    pub scope: Option<String>,
    pub text: String,
}

/// Which tool calls the live stream saw running at the same time, by tool id.
/// Saved history does not keep this, so the trace reads it from here.
static BATCHES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(Default::default);

pub fn note_batch(tool: &str, batch: &str) {
    if let Ok(mut batches) = BATCHES.lock() {
        batches.insert(tool.to_owned(), batch.to_owned());
    }
}

fn batch_of(tool: &str) -> Option<String> {
    BATCHES.lock().ok()?.get(tool).cloned()
}

/// Tools that only load other tools say nothing about the work.
pub fn internal(tool: &Value) -> bool {
    tool["name"]
        .as_str()
        .is_some_and(|name| name.eq_ignore_ascii_case("toolsearch"))
}

fn split(text: &str) -> Vec<(Vec<String>, bool)> {
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
    parts
}
fn noise(word: &str) -> bool {
    matches!(
        word,
        "cd" | "true"
            | "false"
            | "echo"
            | "printf"
            | "for"
            | "while"
            | "if"
            | "fi"
            | "done"
            | "esac"
    )
}
fn words(text: &str, depth: usize) -> Vec<String> {
    if depth > 6 {
        return vec![];
    }
    let parts = split(text);
    let selected = parts
        .iter()
        .rev()
        .find(|(p, piped)| !piped && !noise(&p[0]))
        .or_else(|| parts.iter().find(|(_, p)| !p));
    normalize(selected.map(|(w, _)| w.clone()).unwrap_or_default(), depth)
}
/// Each command a chained shell line runs, without pipes' receiving ends,
/// directory changes or loop keywords.
fn commands(text: &str) -> Vec<Vec<String>> {
    split(text)
        .into_iter()
        .filter_map(|(mut part, piped)| {
            while part
                .first()
                .is_some_and(|w| matches!(w.as_str(), "do" | "then" | "else"))
            {
                part.remove(0);
            }
            (!piped && part.first().is_some_and(|w| !noise(w))).then(|| normalize(part, 0))
        })
        .filter(|w| !w.is_empty())
        .collect()
}
fn normalize(mut w: Vec<String>, depth: usize) -> Vec<String> {
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
        "apply_patch"
            | "edit"
            | "multiedit"
            | "write"
            | "write_file"
            | "edit_file"
            | "notebookedit"
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
    } else if matches!(exe, "webfetch" | "web_fetch" | "fetch_url" | "read_url") {
        "web-read".into()
    } else if matches!(exe, "todowrite" | "update_plan") {
        "plan".into()
    } else if matches!(exe, "task" | "agent") {
        "agent".into()
    } else {
        format!("command:{exe}")
    }
}
/// Arguments that are not flags or a flag's value.
fn positional<'a>(exe: &str, w: &'a [String]) -> Vec<&'a str> {
    let valued: &[&str] = match exe {
        "head" | "tail" => &["-n", "-c"],
        "sed" => &["-e", "-f"],
        "find" => &[
            "-name",
            "-iname",
            "-path",
            "-type",
            "-maxdepth",
            "-mindepth",
            "-newer",
            "-size",
        ],
        _ => &[
            "-e",
            "-f",
            "-g",
            "--glob",
            "-t",
            "--type",
            "-T",
            "--type-not",
            "-m",
            "--max-count",
            "-A",
            "-B",
            "-C",
            "--context",
        ],
    };
    let mut out = vec![];
    let mut words = w.iter().skip(1);
    while let Some(word) = words.next() {
        if valued.contains(&word.as_str()) {
            words.next();
        } else if !word.starts_with('-') {
            out.push(word.as_str());
        }
    }
    out
}
fn flag_value<'a>(w: &'a [String], flags: &[&str]) -> Option<&'a str> {
    w.iter()
        .position(|word| flags.contains(&word.as_str()))
        .and_then(|i| w.get(i + 1))
        .map(String::as_str)
}
/// The work one shell command did: which files it read, what it searched for
/// and where, or which folder it listed.
fn shell_parts(w: &[String]) -> Vec<Part> {
    let exe = base(&w[0]);
    let key = group_key(exe, w);
    let text = w.join(" ");
    let args = positional(exe, w);
    let path = |s: &&str| !s.is_empty() && !s.starts_with('$') && !s.contains('*');
    let part = |subject: Option<&str>, scope: Option<&str>| Part {
        key: key.clone(),
        subject: subject.map(str::to_owned),
        scope: scope.map(str::to_owned),
        text: text.clone(),
    };
    match key.as_str() {
        "read" => {
            let files: Vec<&str> = args
                .iter()
                .skip(usize::from(
                    exe == "sed" && flag_value(w, &["-e"]).is_none(),
                ))
                .copied()
                .filter(path)
                .collect();
            if files.is_empty() {
                vec![part(None, None)]
            } else {
                files
                    .into_iter()
                    .map(|file| part(Some(file), None))
                    .collect()
            }
        }
        "search" if exe == "find" => vec![part(
            flag_value(w, &["-name", "-iname", "-path"]),
            args.first().copied().filter(path),
        )],
        "search" => {
            let args = if exe == "git" {
                &args[1.min(args.len())..]
            } else {
                &args[..]
            };
            let pattern = args.first().copied().or_else(|| flag_value(w, &["-e"]));
            vec![part(pattern, args.get(1).copied().filter(path))]
        }
        "list" => vec![part(args.first().copied().filter(path), None)],
        _ => vec![part(None, None)],
    }
}
/// Paths at the start of output lines, as search tools print them.
fn found(result: &str) -> Vec<String> {
    let mut files: Vec<String> = vec![];
    for line in result.lines().take(400) {
        let candidate = line.trim().split(':').next().unwrap_or("").trim();
        let extension = candidate.rsplit_once('.').is_some_and(|(stem, extension)| {
            !stem.is_empty()
                && (1..=6).contains(&extension.len())
                && extension.chars().all(|c| c.is_ascii_alphanumeric())
                && extension.chars().any(|c| c.is_ascii_alphabetic())
        });
        let pathlike = !candidate.is_empty()
            && candidate.len() < 240
            && !candidate.contains(char::is_whitespace)
            && (candidate.contains('/') || extension);
        if pathlike && !files.iter().any(|file| file == candidate) {
            files.push(candidate.to_owned());
        }
    }
    files
}
/// The "Links: [...]" lists a web search prints.
fn links(result: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![];
    let mut rest = result;
    while let Some(at) = rest.find("Links: [") {
        rest = &rest[at + "Links: ".len()..];
        let list = serde_json::Deserializer::from_str(rest)
            .into_iter::<Vec<Value>>()
            .next()
            .and_then(Result::ok)
            .unwrap_or_default();
        for link in list {
            if let Some(url) = link["url"].as_str()
                && !out.iter().any(|(_, known)| known == url)
            {
                out.push((
                    link["title"].as_str().unwrap_or("").to_owned(),
                    url.to_owned(),
                ));
            }
        }
    }
    out
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
    let arg = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| args[*k].as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
    };
    let mut parts = if shell {
        commands(if raw.is_string() { &raw_text } else { &command })
            .iter()
            .flat_map(|w| shell_parts(w))
            .collect()
    } else {
        let (subject, scope) = match key.as_str() {
            "search" => (arg(&["pattern", "query", "regex"]), arg(&["path", "glob"])),
            "list" => (
                arg(&["pattern", "path"]),
                arg(&["path"]).filter(|_| args["pattern"].is_string()),
            ),
            "web-search" => (arg(&["query", "q"]), None),
            "web-read" => (arg(&["url", "uri"]), None),
            "agent" => (arg(&["description", "prompt"]), None),
            _ => (subject.clone(), None),
        };
        vec![Part {
            key: key.clone(),
            subject,
            scope,
            text: command.clone(),
        }]
    };
    if parts.is_empty() {
        parts.push(Part {
            key: key.clone(),
            subject: subject.clone(),
            scope: None,
            text: command.clone(),
        });
    }
    let output = tool["result"].as_str().unwrap_or("");
    let searched = parts.len() == 1 && matches!(parts[0].key.as_str(), "search" | "list");
    Step {
        id: id.into(),
        command,
        found: if searched && status == "ok" {
            found(output)
        } else {
            vec![]
        },
        links: if key == "web-search" {
            links(output)
        } else {
            vec![]
        },
        batch: tool["batch"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| batch_of(id)),
        status,
        reason,
        group: 0,
        group_key: key,
        subject: parts[0].subject.clone().or(subject),
        parts,
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
            parts: vec![],
            found: vec![],
            links: vec![],
            batch: None,
        }
    }

    fn parts(command: &str) -> Vec<(String, Option<String>, Option<String>)> {
        activity(
            "t",
            &serde_json::json!({"name":"Bash","args":{"command":command}}),
            "",
        )
        .parts
        .into_iter()
        .map(|part| (part.key, part.subject, part.scope))
        .collect()
    }

    #[test]
    fn a_chained_shell_line_is_worded_as_each_command_it_runs() {
        let some = |s: &str| Some(s.to_owned());
        assert_eq!(
            parts(
                "cd repo && rg -il orchestrator src/lib | wc -l; cat package.json tsconfig.json && ls scripts; git status --short"
            ),
            vec![
                ("search".into(), some("orchestrator"), some("src/lib")),
                ("read".into(), some("package.json"), None),
                ("read".into(), some("tsconfig.json"), None),
                ("list".into(), some("scripts"), None),
                ("git:status".into(), None, None),
            ]
        );
        assert_eq!(
            parts("for f in a.rs b.rs; do echo \"== $f\"; head -40 \"$f\" | cut -c1-80; done"),
            vec![("read".into(), None, None)],
            "loop words and shell variables are not work"
        );
        assert_eq!(parts("sed -n 1,20p src/a.rs")[0].1, some("src/a.rs"));
        assert_eq!(
            parts("find src -name '*.ts'")[0],
            ("search".into(), some("*.ts"), some("src"))
        );
    }

    #[test]
    fn web_steps_keep_their_query_results_and_pages() {
        let search = activity(
            "w1",
            &serde_json::json!({"name":"WebSearch","args":{"query":"gpui list animation"},"status":"done",
                "result":"Web search results for query: \"gpui\"\n\nLinks: [{\"title\":\"Animation – GPUI\",\"url\":\"https://gpui.rs/animation\"},{\"title\":\"docs.rs\",\"url\":\"https://docs.rs/gpui/latest/gpui/\"}]\n\nMore text"}),
            "",
        );
        assert_eq!(search.group_key, "web-search");
        assert_eq!(search.subject.as_deref(), Some("gpui list animation"));
        assert_eq!(
            search.links,
            vec![
                (
                    "Animation – GPUI".into(),
                    "https://gpui.rs/animation".into()
                ),
                ("docs.rs".into(), "https://docs.rs/gpui/latest/gpui/".into()),
            ]
        );
        let fetch = activity(
            "w2",
            &serde_json::json!({"name":"WebFetch","args":{"url":"https://gpui.rs/animation","prompt":"x"}}),
            "",
        );
        assert_eq!(
            (fetch.group_key.as_str(), fetch.subject.as_deref()),
            ("web-read", Some("https://gpui.rs/animation"))
        );
        assert!(internal(&serde_json::json!({"name":"ToolSearch"})));
    }

    #[test]
    fn a_search_lists_the_files_it_matched_and_a_batch_survives_history() {
        let grep = activity(
            "g1",
            &serde_json::json!({"name":"Grep","args":{"pattern":"route","path":"src"},"status":"done",
                "result":"Found 3 files\nsrc/router.ts\nsrc/auth.ts:12:  route()\nv0.1.812"}),
            "",
        );
        assert_eq!(grep.parts[0].subject.as_deref(), Some("route"));
        assert_eq!(grep.parts[0].scope.as_deref(), Some("src"));
        assert_eq!(grep.found, ["src/router.ts", "src/auth.ts"]);
        note_batch("g2", "g1");
        let later = activity(
            "g2",
            &serde_json::json!({"name":"Read","args":{"file_path":"a.rs"}}),
            "",
        );
        assert_eq!(later.batch.as_deref(), Some("g1"));
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
