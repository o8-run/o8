//! A `!` line's completions (the command word, then paths in the project)
//! and the block "Add to chat" puts in the draft.
use crate::terminal_grid::{CommandOutput, Mark};
use serde_json::Value;
use std::time::{Duration, Instant};

/// At most this many completions show at once.
pub(crate) const RESULTS: usize = 12;
/// Add to chat keeps at most this many of the last output lines and characters.
pub(crate) const OUTPUT_LINES: usize = 200;
pub(crate) const OUTPUT_CHARS: usize = 8_000;

/// The card shows at most this many of the last output lines; Copy and
/// Add to chat take more.
pub(crate) const CARD_LINES: usize = 8;

/// The `!` line the composer last ran, until it goes to the chat or away.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ShellRun {
    pub line: String,
    /// Esc already stopped it, so the next Esc stops the turn again.
    pub stopped: bool,
    pub started: Instant,
    /// The terminal just before the line went in: output and exit reports
    /// count only after it.
    pub before: Option<Mark>,
    /// What it printed so far, stdout and stderr as the terminal shows them.
    pub output: Vec<String>,
    /// How long it ran, once its prompt came back.
    pub took: Option<Duration>,
    /// The exit status, when the shell reports one (OSC 133;D).
    pub exit: Option<i32>,
    /// Its own echo reached the terminal, so the output read is this run's.
    pub seen: bool,
    /// Its echo or terminal went away before its prompt came back; the card
    /// keeps what it last read and stops following.
    pub lost: bool,
    /// The thread's store this card is saved beside once it finishes.
    pub store: Option<std::path::PathBuf>,
    /// Read back from the store after a relaunch: its terminal is gone, so
    /// Add to chat uses the output kept with the card.
    pub restored: bool,
}

/// A finished card as kept beside the thread's mode and drafts, so it is
/// still there after the app restarts (#5304). Never sent to the agent.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedRun {
    pub line: String,
    pub output: Vec<String>,
    pub took_ms: u64,
    pub exit: Option<i32>,
    pub stopped: bool,
    pub lost: bool,
}

impl ShellRun {
    pub fn new(line: String, started: Instant) -> Self {
        Self {
            line,
            stopped: false,
            started,
            before: None,
            output: vec![],
            took: None,
            exit: None,
            seen: false,
            lost: false,
            store: None,
            restored: false,
        }
    }
    /// The card to keep once it has finished, with the same output bound as
    /// Add to chat; none while it still runs.
    pub fn saved(&self) -> Option<SavedRun> {
        let took = self.took?;
        let mut output = self.output[self.output.len().saturating_sub(OUTPUT_LINES)..].to_vec();
        let mut chars: usize = output.iter().map(|line| line.chars().count() + 1).sum();
        while chars > OUTPUT_CHARS && output.len() > 1 {
            chars -= output.remove(0).chars().count() + 1;
        }
        Some(SavedRun {
            line: self.line.clone(),
            output,
            took_ms: took.as_millis().min(u64::MAX as u128) as u64,
            exit: self.exit,
            stopped: self.stopped,
            lost: self.lost,
        })
    }
    /// A kept card, finished as it was saved.
    pub fn restore(saved: SavedRun, store: Option<std::path::PathBuf>, now: Instant) -> Self {
        let took = Duration::from_millis(saved.took_ms);
        Self {
            line: saved.line,
            stopped: saved.stopped,
            started: now.checked_sub(took).unwrap_or(now),
            before: None,
            output: saved.output,
            took: Some(took),
            exit: saved.exit,
            seen: true,
            lost: saved.lost,
            store,
            restored: true,
        }
    }
    pub fn running(&self) -> bool {
        self.took.is_none()
    }
    /// Takes a read of the terminal (none when its pane is gone); true when
    /// the card changed.
    pub fn read(
        &mut self,
        output: Option<CommandOutput>,
        mark: Option<Mark>,
        now: Instant,
    ) -> bool {
        let Some(before) = self.before.filter(|_| self.running()) else {
            return false;
        };
        let (Some(output), Some(mark)) = (output, mark) else {
            // A cleared or scrolled-away echo, or a closed terminal, ends the
            // card where it is rather than leaving it running.
            if self.seen || mark.is_none() {
                self.took = Some(now.saturating_duration_since(self.started));
                self.lost = true;
                return true;
            }
            return false;
        };
        // Only a new live echo of the line is this run: a replayed or older
        // echo of the same line is not.
        if !self.seen {
            if mark.live <= before.live || mark.echoes <= before.echoes {
                return false;
            }
            self.seen = true;
        }
        let changed = output.lines != self.output || output.finished;
        self.output = output.lines;
        if output.finished {
            self.took = Some(now.saturating_duration_since(self.started));
            self.exit = (mark.exits > before.exits).then_some(mark.exit).flatten();
        }
        changed
    }
    /// "running", "stopping", "finished", "stopped" or "lost".
    pub fn state(&self) -> &'static str {
        if self.lost {
            return "lost";
        }
        match (self.running(), self.stopped) {
            (true, false) => "running",
            (true, true) => "stopping",
            (false, false) => "finished",
            (false, true) => "stopped",
        }
    }
    /// "Running 3s" while it runs (the clock ticks once a second), then
    /// "Finished · 0.6s · exit 0".
    pub fn status(&self, now: Instant) -> String {
        let Some(took) = self.took else {
            let label = if self.stopped { "Stopping" } else { "Running" };
            let seconds = now.saturating_duration_since(self.started).as_secs();
            return format!("{label} {seconds}s");
        };
        let label = if self.lost {
            "Left the terminal"
        } else if self.stopped {
            "Stopped"
        } else {
            "Finished"
        };
        let mut status = format!("{label} · {:.1}s", took.as_secs_f64());
        if let Some(code) = self.exit {
            status.push_str(&format!(" · exit {code}"));
        }
        status
    }
    /// The command and all it printed, for the clipboard.
    pub fn copy_text(&self) -> String {
        let mut text = format!("$ {}", self.line);
        for line in &self.output {
            text.push('\n');
            text.push_str(line);
        }
        text
    }
}

/// The word the cursor ends in a `!` line: where it starts, the word, and
/// whether it is a command (the first word, or one after `|`, `;` or `&`)
/// rather than a path.
pub(crate) fn token(text: &str, cursor: usize) -> Option<(usize, &str, bool)> {
    if !text.starts_with('!') || text.contains('\n') || cursor < 1 {
        return None;
    }
    let head = text.get(1..cursor)?;
    let start = 1 + head
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map_or(0, |(index, c)| index + c.len_utf8());
    let word = &text[start..cursor];
    // Flags and `@` words are left alone.
    if word.is_empty() || word.starts_with(['-', '@']) {
        return None;
    }
    let before = text[1..start].trim_end();
    let command = !word.contains('/') && (before.is_empty() || before.ends_with(['|', ';', '&']));
    Some((start, word, command))
}

/// Commands starting with the word, the shortest first.
pub(crate) fn command_matches(names: &[String], word: &str) -> Vec<String> {
    let mut matches: Vec<&String> = names.iter().filter(|n| n.starts_with(word)).collect();
    matches.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
    matches.into_iter().take(RESULTS).cloned().collect()
}

/// The executables on this computer's PATH, read once and capped. Call it off
/// the paint thread: the first call reads every PATH folder.
pub(crate) fn executables() -> &'static [String] {
    const LIMIT: usize = 10_000;
    static NAMES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    NAMES.get_or_init(|| {
        let mut names = std::collections::BTreeSet::new();
        let path = std::env::var_os("PATH").unwrap_or_default();
        for folder in std::env::split_paths(&path) {
            let Ok(entries) = std::fs::read_dir(folder) else {
                continue;
            };
            for entry in entries.flatten().take(LIMIT) {
                if names.len() >= LIMIT {
                    break;
                }
                if executable(&entry.path())
                    && let Some(name) = entry.file_name().to_str()
                {
                    names.insert(name.to_owned());
                }
            }
        }
        names.into_iter().collect()
    })
}
#[cfg(unix)]
fn executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}
#[cfg(not(unix))]
fn executable(path: &std::path::Path) -> bool {
    path.is_file()
}

/// A path word's folder, kept as typed, and the name being typed in it.
pub(crate) fn split_path(word: &str) -> (&str, &str) {
    word.rfind('/')
        .map_or(("", word), |slash| word.split_at(slash + 1))
}

/// The entries of a files listing whose names start with the typed name, as
/// the folder plus name, and whether each is a folder. Names in the typed
/// case lead, then the shortest; hidden names show only once `.` is typed.
pub(crate) fn path_matches(body: &Value, folder: &str, prefix: &str) -> Vec<(String, bool)> {
    let lower = prefix.to_lowercase();
    let mut matches: Vec<(&str, bool)> = body["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let name = entry["name"].as_str()?;
            let directory = entry["kind"] == "directory" || entry["type"] == "dir";
            (name.to_lowercase().starts_with(&lower)
                && (prefix.starts_with('.') || !name.starts_with('.')))
            .then_some((name, directory))
        })
        .collect();
    matches.sort_by_key(|(name, _)| (!name.starts_with(prefix), name.len(), *name));
    matches
        .into_iter()
        .take(RESULTS)
        .map(|(name, directory)| (format!("{folder}{name}"), directory))
        .collect()
}

/// The command and the tail of its output, fenced, saying when it was cut.
pub(crate) fn chat_block(command: &str, output: &[String], finished: bool) -> String {
    let mut kept: Vec<&str> = output[output.len().saturating_sub(OUTPUT_LINES)..]
        .iter()
        .map(String::as_str)
        .collect();
    let mut chars = 0;
    let mut first = kept.len();
    while first > 0 && chars + kept[first - 1].chars().count() < OUTPUT_CHARS {
        first -= 1;
        chars += kept[first].chars().count() + 1;
    }
    kept.drain(..first);
    // One line wider than the whole budget keeps its end.
    let tail: String;
    if kept.is_empty()
        && let Some(last) = output.last()
    {
        let skip = last.chars().count().saturating_sub(OUTPUT_CHARS);
        tail = last.chars().skip(skip).collect();
        kept.push(&tail);
    }
    let longest = output
        .iter()
        .flat_map(|line| line.split(|c| c != '`'))
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    let mut block = format!("{fence}console\n$ {command}\n");
    for line in &kept {
        block.push_str(line);
        block.push('\n');
    }
    block.push_str(&fence);
    if kept.len() < output.len() {
        block.push_str(&format!(
            "\n(Output cut to the last {} of {} lines.)",
            kept.len(),
            output.len()
        ));
    }
    if !finished {
        block.push_str("\n(Still running when added.)");
    }
    block
}

/// The block goes above whatever the draft already says.
pub(crate) fn with_block(draft: &str, block: &str) -> String {
    format!("{block}\n\n{}", draft.trim_start())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_first_word_is_a_command_and_later_words_are_paths() {
        assert_eq!(token("!gi", 3), Some((1, "gi", true)));
        assert_eq!(token("! gi", 4), Some((2, "gi", true)));
        assert_eq!(token("!git sr", 7), Some((5, "sr", false)));
        assert_eq!(token("!cat src/ma", 11), Some((5, "src/ma", false)));
        assert_eq!(token("!git log | gr", 13), Some((11, "gr", true)));
        assert_eq!(token("!make && ca", 11), Some((9, "ca", true)));
        assert_eq!(token("!./scr", 6), Some((1, "./scr", false)));
        assert_eq!(token("!git ", 5), None, "nothing typed yet");
        assert_eq!(token("!ls -l", 6), None, "a flag is no path");
        assert_eq!(token("gi", 2), None, "not a ! line");
        assert_eq!(token("!git\nst", 7), None, "several lines stay a message");
        assert_eq!(token("!gi", 1), None);
    }

    #[test]
    fn commands_lead_with_the_shortest_name_and_stop_at_the_cap() {
        let names: Vec<String> = ["basename", "bash", "base64", "git", "ba"]
            .into_iter()
            .map(str::to_owned)
            .chain((0..30).map(|n| format!("bz{n:02}")))
            .collect();
        assert_eq!(
            command_matches(&names, "bas"),
            ["bash", "base64", "basename"]
        );
        assert_eq!(command_matches(&names, "b").len(), RESULTS);
        assert_eq!(command_matches(&names, "b")[0], "ba");
        assert!(command_matches(&names, "zz").is_empty());
    }

    #[test]
    fn paths_keep_the_typed_folder_and_mark_folders() {
        assert_eq!(split_path("src/ma"), ("src/", "ma"));
        assert_eq!(split_path("./sc"), ("./", "sc"));
        assert_eq!(split_path("ma"), ("", "ma"));
        assert_eq!(split_path("src/"), ("src/", ""));
        let body = json!({"entries":[
            {"name":"main.rs","path":"src/main.rs","kind":"file"},
            {"name":"Makefile","path":"src/Makefile","kind":"file"},
            {"name":"markdown","path":"src/markdown","kind":"directory"},
            {"name":"lib.rs","path":"src/lib.rs","kind":"file"},
            {"name":".map","path":"src/.map","kind":"file"},
        ]});
        assert_eq!(
            path_matches(&body, "src/", "ma"),
            [
                ("src/main.rs".to_owned(), false),
                ("src/markdown".to_owned(), true),
                ("src/Makefile".to_owned(), false),
            ],
            "the typed case first, then the shortest, and no hidden names"
        );
        assert_eq!(path_matches(&body, "src/", ".m").len(), 1);
        let many = json!({"entries": (0..40)
            .map(|n| json!({"name": format!("f{n}"), "kind": "file"}))
            .collect::<Vec<_>>()});
        assert_eq!(path_matches(&many, "", "f").len(), RESULTS);
    }

    #[test]
    fn add_to_chat_keeps_the_tail_and_says_when_it_was_cut() {
        let short = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(
            chat_block("ls", &short, true),
            "```console\n$ ls\na\nb\n```"
        );
        let long: Vec<String> = (0..500).map(|n| format!("line {n}")).collect();
        let block = chat_block("seq", &long, true);
        assert!(block.contains("line 499\n```"));
        assert!(!block.contains("line 299\n"));
        assert!(block.contains("line 300\n"));
        assert!(block.ends_with("(Output cut to the last 200 of 500 lines.)"));
        let wide: Vec<String> = (0..100).map(|n| format!("{n:0>200}")).collect();
        let block = chat_block("wide", &wide, true);
        assert!(block.chars().count() < OUTPUT_CHARS + 200);
        assert!(block.ends_with("of 100 lines.)"));
        let fenced = vec!["```".to_owned(), "````".to_owned()];
        assert!(
            chat_block("cat notes.md", &fenced, true).starts_with("`````console\n"),
            "output fences never close the block"
        );
        assert!(chat_block("sleep 9", &[], false).ends_with("(Still running when added.)"));
    }

    fn mark(live: u64, echoes: usize, exits: u64, exit: Option<i32>) -> Option<Mark> {
        Some(Mark {
            live,
            echoes,
            exits,
            exit,
        })
    }
    fn output(lines: &[&str], finished: bool) -> Option<CommandOutput> {
        Some(CommandOutput {
            lines: lines.iter().map(|line| (*line).to_owned()).collect(),
            finished,
        })
    }

    #[test]
    fn a_card_follows_its_run_from_the_mark_to_the_exit() {
        let start = Instant::now();
        let at = |ms| start + Duration::from_millis(ms);
        let mut run = ShellRun::new("make".into(), start);
        assert!(
            !run.read(output(&["old"], true), mark(5, 2, 1, Some(0)), at(5)),
            "nothing counts before the shell says where the terminal stood"
        );
        // An earlier `make` is still on screen when this one is typed.
        run.before = mark(4, 1, 1, Some(0));
        assert!(
            !run.read(output(&["old"], true), mark(9, 1, 1, Some(0)), at(5)),
            "a prompt redraw or replay before the new echo shows the old run"
        );
        assert!(
            !run.read(output(&["old"], true), mark(4, 2, 1, Some(0)), at(5)),
            "an echo that only a replay brought back is not this run"
        );
        assert_eq!(
            (run.state(), run.status(at(1_400))),
            ("running", "Running 1s".into())
        );
        assert!(run.read(output(&["a"], false), mark(10, 2, 1, Some(0)), at(100)));
        assert!(run.read(output(&["a", "b"], false), mark(11, 2, 1, Some(0)), at(200)));
        assert!(!run.read(output(&["a", "b"], false), mark(12, 2, 1, Some(0)), at(300)));
        assert_eq!(run.output, ["a", "b"]);
        assert!(run.read(output(&["a", "b"], true), mark(13, 2, 2, Some(2)), at(600)));
        assert_eq!(run.took, Some(Duration::from_millis(600)));
        assert_eq!(run.exit, Some(2));
        assert_eq!(
            (run.state(), run.status(at(9_000))),
            ("finished", "Finished · 0.6s · exit 2".into()),
            "a finished clock stops"
        );
        assert!(
            !run.read(output(&["later"], true), mark(14, 2, 2, Some(2)), at(700)),
            "a finished card no longer changes"
        );
        assert_eq!(run.copy_text(), "$ make\na\nb");
    }

    #[test]
    fn an_exit_counts_only_when_reported_after_the_run_began() {
        let start = Instant::now();
        let mut run = ShellRun::new("ls".into(), start);
        run.before = mark(10, 0, 3, Some(1));
        run.read(output(&["x"], true), mark(11, 1, 3, Some(1)), start);
        assert_eq!(run.exit, None, "the shell reported nothing for this run");
        assert_eq!(run.status(start), "Finished · 0.0s");
        let mut stopped = ShellRun::new("sleep 30".into(), start);
        stopped.before = Some(Mark::default());
        stopped.stopped = true;
        assert_eq!(stopped.status(start), "Stopping 0s");
        assert_eq!(stopped.state(), "stopping");
        stopped.read(output(&["CTRL-C"], true), mark(1, 1, 1, Some(130)), start);
        assert_eq!(
            (stopped.state(), stopped.status(start)),
            ("stopped", "Stopped · 0.0s · exit 130".into())
        );
    }

    #[test]
    fn a_run_whose_echo_or_terminal_goes_away_stops_running() {
        let start = Instant::now();
        let at = |ms| start + Duration::from_millis(ms);
        let mut run = ShellRun::new("yes".into(), start);
        run.before = Some(Mark::default());
        assert!(
            !run.read(None, mark(1, 0, 0, None), at(10)),
            "no echo yet is still running"
        );
        assert!(run.read(output(&["y"], false), mark(2, 1, 0, None), at(20)));
        // The echo scrolled past the lookback, or `clear` erased it.
        assert!(run.read(None, mark(3, 0, 0, None), at(2_000)));
        assert_eq!(
            (run.state(), run.status(at(9_000))),
            ("lost", "Left the terminal · 2.0s".into())
        );
        assert_eq!(run.output, ["y"], "the card keeps what it last read");
        let mut closed = ShellRun::new("ls".into(), start);
        closed.before = Some(Mark::default());
        assert!(closed.read(None, None, at(50)), "the terminal pane closed");
        assert_eq!(closed.state(), "lost");
    }

    #[test]
    fn the_block_goes_above_the_draft() {
        assert_eq!(with_block("", "B"), "B\n\n");
        assert_eq!(with_block("  ", "B"), "B\n\n");
        assert_eq!(with_block("why?", "B"), "B\n\nwhy?");
    }
}
