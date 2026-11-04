//! `@` beyond threads and files: the lane roster's agents, the project's
//! worktrees, its package scripts and the open terminals. A pick keeps its
//! label in the draft; on send each becomes a short context block for the
//! agent, and the sent message's pill previews it on hover.
use super::{attribute, bounded, escaped, trimmed};
use crate::subagents::model::{Agent, Group};
use crate::text::{Node, Run};
use serde_json::Value;
use std::cell::RefCell;

/// Each agent, worktree, script or terminal block fits this many characters,
/// its tags included.
pub(crate) const BLOCK_BUDGET: usize = 2_000;
/// A terminal mention carries its newest lines, at most this many.
pub(crate) const TERMINAL_LINES: usize = 40;
/// Results per group, as threads have.
const LIMIT: usize = 6;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Mentioned {
    Agent {
        id: String,
        label: String,
        status: String,
        activity: String,
        /// The agent's own thread, when it has one, for a click to open.
        session: Option<String>,
    },
    Worktree {
        label: String,
        path: String,
        branch: Option<String>,
    },
    Script {
        name: String,
        command: String,
    },
    /// Its lines are read when the message is sent.
    Terminal {
        session: String,
        lines: Vec<String>,
    },
}
impl Mentioned {
    pub(crate) fn label(&self) -> &str {
        match self {
            Self::Agent { label, .. } | Self::Worktree { label, .. } => label,
            Self::Script { name, .. } => name,
            Self::Terminal { session, .. } => session,
        }
    }
    pub(crate) fn group(&self) -> &'static str {
        match self {
            Self::Agent { .. } => "Agents",
            Self::Worktree { .. } => "Worktrees",
            Self::Script { .. } | Self::Terminal { .. } => "Scripts & terminals",
        }
    }
    /// What the menu shows beside the label.
    pub(crate) fn detail(&self) -> String {
        match self {
            Self::Agent { status, .. } => status.clone(),
            Self::Worktree { path, .. } => path.clone(),
            Self::Script { command, .. } => command.clone(),
            Self::Terminal { .. } => "Terminal".into(),
        }
    }
    /// The same pick, so a second pick replaces the first.
    fn same(&self, other: &Self) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
            && self.label() == other.label()
    }
}

fn found(label: &str, query: &str) -> bool {
    label.to_lowercase().contains(&query.to_lowercase())
}
/// Running work leads, then work that needs a look, then finished work;
/// the newest first in each.
pub(crate) fn agent_matches(agents: &[Agent], query: &str) -> Vec<Mentioned> {
    let rank = |group: Group| match group {
        Group::Working => 0,
        Group::Attention => 1,
        Group::Done => 2,
    };
    let mut agents: Vec<_> = agents.iter().filter(|a| found(&a.title, query)).collect();
    agents.sort_by(|a, b| {
        rank(a.group)
            .cmp(&rank(b.group))
            .then_with(|| {
                let time = |a: &Agent| a.finished.or(a.started).unwrap_or(0.);
                time(*b).total_cmp(&time(*a))
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    agents
        .into_iter()
        .take(LIMIT)
        .map(|agent| Mentioned::Agent {
            id: agent.id.clone(),
            label: agent.title.clone(),
            status: agent.status.clone(),
            activity: activity(agent),
            session: agent
                .session
                .as_deref()
                .map(|s| s.strip_prefix("llm-chat:").unwrap_or(s).to_owned()),
        })
        .collect()
}
/// The agent's last reported line: its blocker or latest event, else its result.
fn activity(agent: &Agent) -> String {
    agent
        .progress
        .as_deref()
        .or(agent.result.as_deref())
        .and_then(|text| text.lines().rev().find(|line| !line.trim().is_empty()))
        .unwrap_or("")
        .trim()
        .to_owned()
}
/// The project's worktrees from the review snapshot's listing. Agent scratch
/// worktrees stay out unless current, as in the activity dock.
pub(crate) fn worktree_matches(snapshot: &Value, query: &str) -> Vec<Mentioned> {
    snapshot["worktrees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tree| {
            let path = tree["absolutePath"].as_str().or(tree["path"].as_str())?;
            let current = tree["isCurrent"] == true;
            if !current && path.contains("/.claude/worktrees/agent-") {
                return None;
            }
            let branch = tree["branch"].as_str().filter(|b| !b.is_empty());
            let label = branch
                .or_else(|| path.trim_end_matches('/').rsplit('/').next())
                .filter(|label| !label.is_empty())?;
            (found(label, query) || found(path, query)).then(|| Mentioned::Worktree {
                label: label.to_owned(),
                path: path.to_owned(),
                branch: branch.map(str::to_owned),
            })
        })
        .take(LIMIT)
        .collect()
}
/// `scripts` from the project's package.json, as the files route read it.
pub(crate) fn script_matches(file: &Value, query: &str) -> Vec<Mentioned> {
    let Some(package) = file["content"]
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
    else {
        return vec![];
    };
    package["scripts"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, command)| {
            let command = command.as_str()?;
            found(name, query).then(|| Mentioned::Script {
                name: name.clone(),
                command: command.to_owned(),
            })
        })
        .take(LIMIT)
        .collect()
}
pub(crate) fn terminal_matches(sessions: &[String], query: &str) -> Vec<Mentioned> {
    sessions
        .iter()
        .filter(|session| found(session, query))
        .take(LIMIT)
        .map(|session| Mentioned::Terminal {
            session: session.clone(),
            lines: vec![],
        })
        .collect()
}

/// A block of `body` lines inside `header` and `footer`, within the budget.
/// A tail keeps its newest lines whole and drops the oldest; other bodies
/// are cut short at the end.
fn fit(header: String, body: Vec<String>, footer: &str, tail: bool) -> String {
    let room = BLOCK_BUDGET
        .saturating_sub(header.chars().count())
        .saturating_sub(footer.chars().count());
    let length = |lines: &[String]| {
        lines.iter().map(|l| l.chars().count()).sum::<usize>() + lines.len().saturating_sub(1)
    };
    let mut body = body;
    if tail {
        while body.len() > 1 && length(&body) > room {
            body.remove(0);
        }
    }
    let text = trimmed(&body.join("\n"), room);
    format!("{header}{text}{footer}")
}
/// What the agent receives for one mention. `dirty` is a worktree's own
/// changes snapshot, read on send.
pub(crate) fn object_block(object: &Mentioned, dirty: Option<Result<Value, String>>) -> String {
    match object {
        Mentioned::Agent {
            label,
            status,
            activity,
            ..
        } => fit(
            format!(
                "<mentioned-agent label=\"{}\" status=\"{}\">\n",
                attribute(label),
                attribute(status)
            ),
            vec![escaped(if activity.is_empty() {
                "No activity reported yet."
            } else {
                activity
            })],
            "\n</mentioned-agent>",
            false,
        ),
        Mentioned::Worktree { path, branch, .. } => {
            let (state, note) = match dirty {
                Some(Ok(snapshot)) => {
                    let changed = snapshot["changedFiles"].as_array().map_or(0, Vec::len);
                    if snapshot["dirty"] == true || changed > 0 {
                        ("dirty", format!("{changed} changed files."))
                    } else {
                        ("clean", "No uncommitted changes.".into())
                    }
                }
                _ => ("unknown", "Its changes could not be read.".into()),
            };
            fit(
                format!(
                    "<mentioned-worktree path=\"{}\" branch=\"{}\" state=\"{state}\">\n",
                    attribute(path),
                    attribute(branch.as_deref().unwrap_or("detached"))
                ),
                vec![note],
                "\n</mentioned-worktree>",
                false,
            )
        }
        Mentioned::Script { name, command } => fit(
            format!("<mentioned-script name=\"{}\">\n", attribute(name)),
            vec![escaped(command)],
            "\n</mentioned-script>",
            false,
        ),
        Mentioned::Terminal { session, lines } => fit(
            format!("<mentioned-terminal name=\"{}\">\n", attribute(session)),
            if lines.is_empty() {
                vec!["No output in this terminal.".into()]
            } else {
                lines.iter().map(|line| escaped(line)).collect()
            },
            "\n</mentioned-terminal>",
            true,
        ),
    }
}
/// The blocks for every pick, read on the background executor: a worktree's
/// changes are read through the review route for that worktree.
pub(crate) fn objects_context(client: &crate::client::Client, objects: &[Mentioned]) -> String {
    objects
        .iter()
        .map(|object| {
            let dirty = match object {
                Mentioned::Worktree { path, .. } => Some(client.get::<Value>(
                    "/api/review/workspace",
                    &[("workspace", path.as_str()), ("changesOnly", "1")],
                )),
                _ => None,
            };
            object_block(object, dirty)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The composer keeps its picks while their labels are in the draft.
impl super::Composer {
    pub(crate) fn remember_object(&mut self, object: Mentioned) {
        let picks = &mut self.controls.mention.objects;
        picks.retain(|picked| !picked.same(&object));
        picks.push(object);
    }
    pub(crate) fn object_mentions(&mut self) -> Vec<Mentioned> {
        let text = self.text.clone();
        self.controls
            .mention
            .objects
            .retain(|o| super::contains_title(&text, o.label()));
        self.controls.mention.objects.clone()
    }
}

/// A mention as the sent message shows it: the pill's preview card and the
/// thread a click opens.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Sent {
    pub label: String,
    pub title: String,
    pub lines: Vec<String>,
    pub open: Option<String>,
}
impl Sent {
    pub(crate) fn thread(title: &str, id: &str, status: &str, branch: Option<&str>) -> Self {
        let mut lines = vec![format!("Thread · {status}")];
        lines.extend(branch.map(|branch| format!("Branch {branch}")));
        Self {
            label: title.into(),
            title: title.into(),
            lines,
            open: Some(id.into()),
        }
    }
    pub(crate) fn object(object: &Mentioned) -> Self {
        let (title, lines, open) = match object {
            Mentioned::Agent {
                label,
                status,
                activity,
                session,
                ..
            } => (
                label.clone(),
                [format!("Agent · {status}"), activity.clone()].to_vec(),
                session.clone(),
            ),
            Mentioned::Worktree { path, branch, .. } => (
                path.clone(),
                vec![format!(
                    "Worktree · {}",
                    branch.as_deref().unwrap_or("detached")
                )],
                None,
            ),
            Mentioned::Script { name, command } => {
                (name.clone(), vec![format!("Script · {command}")], None)
            }
            Mentioned::Terminal { session, lines } => (
                session.clone(),
                lines[lines.len().saturating_sub(PREVIEW_LINES)..].to_vec(),
                None,
            ),
        };
        Self {
            label: object.label().into(),
            title,
            lines: lines
                .into_iter()
                .filter(|line| !line.is_empty())
                .map(|line| trimmed(&line, 160))
                .collect(),
            open,
        }
    }
}
/// A preview shows a terminal's newest lines, at most this many.
const PREVIEW_LINES: usize = 6;
pub(crate) const PILL_SCHEME: &str = "o8://mention/";
thread_local! {
    /// Mentions sent from this window, the newest of each kept.
    static SENT: RefCell<Vec<Sent>> = RefCell::default();
}
pub(crate) fn remember_sent(sent: Sent) {
    SENT.with(|all| {
        let mut all = all.borrow_mut();
        // A label names one thing; a thread and a worktree may share it.
        match all
            .iter_mut()
            .find(|known| known.label == sent.label && known.title == sent.title)
        {
            Some(known) => *known = sent,
            None => all.push(sent),
        }
    });
}
fn sent(url: &str) -> Option<Sent> {
    let index: usize = url.strip_prefix(PILL_SCHEME)?.parse().ok()?;
    SENT.with(|all| all.borrow().get(index).cloned())
}
/// The card a sent pill shows on hover: its title and a few lines.
pub(crate) fn sent_preview(url: &str) -> Option<(String, Vec<String>)> {
    sent(url).map(|sent| (sent.title, sent.lines))
}
/// The thread link a sent pill opens, for the transcript's link action.
pub(crate) fn sent_link(url: &str) -> Option<String> {
    sent(url)?.open.map(|thread| crate::lineage::link(&thread))
}
/// A user message's sent mentions read as pills; its words stay as typed.
pub(crate) fn pill_nodes(nodes: &mut [Node]) {
    let mut labels: Vec<(usize, String)> = SENT.with(|all| {
        all.borrow()
            .iter()
            .enumerate()
            .map(|(index, sent)| (index, format!("@{}", sent.label)))
            .collect()
    });
    if labels.is_empty() {
        return;
    }
    labels.sort_by_key(|(_, token)| std::cmp::Reverse(token.len()));
    for node in nodes
        .iter_mut()
        .filter(|node| !matches!(node.kind.as_str(), "code" | "diff"))
    {
        node.runs = std::mem::take(&mut node.runs)
            .into_iter()
            .flat_map(|run| pills(run, &labels))
            .collect();
    }
}
fn pills(run: Run, labels: &[(usize, String)]) -> Vec<Run> {
    if run.style != "text" {
        return vec![run];
    }
    let text = run.text;
    let mut runs = vec![];
    let mut cursor = 0;
    let mut at = 0;
    while at < text.len() {
        let hit = labels.iter().find(|(_, token)| {
            text[at..].starts_with(token.as_str()) && bounded(&text, at, token.len())
        });
        let Some((index, token)) = hit else {
            at += text[at..].chars().next().map_or(1, char::len_utf8);
            continue;
        };
        if at > cursor {
            runs.push(Run {
                style: "text".into(),
                text: text[cursor..at].into(),
            });
        }
        runs.push(Run {
            style: format!("link:{PILL_SCHEME}{index}"),
            text: token.clone(),
        });
        at += token.len();
        cursor = at;
    }
    if cursor < text.len() {
        runs.push(Run {
            style: "text".into(),
            text: text[cursor..].into(),
        });
    }
    runs
}

#[cfg(test)]
#[path = "mention_groups_tests.rs"]
mod tests;
