//! `@` picks workspace files or threads. Thread titles stay visible in the
//! draft while their identities travel separately to the send path.
use super::*;
use commands::Changed;

#[derive(Default)]
pub(crate) struct Mention {
    pub query: Option<String>,
    pub results: Vec<MentionResult>,
    /// Picked titles and ids, retained only while their text is still present.
    pub threads: Vec<(String, String)>,
    pub index: usize,
    pub dismissed: Option<String>,
    pub scroll: ScrollHandle,
    pub search: Option<gpui::Task<()>>,
}
/// The word after `@` changed, so the results need reading again.
pub(crate) struct MentionQuery;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum MentionResult {
    File(String),
    Thread {
        id: String,
        title: String,
        status: String,
    },
}
impl MentionResult {
    pub(crate) fn group(&self) -> &'static str {
        match self {
            Self::File(_) => "Files",
            Self::Thread { .. } => "Threads",
        }
    }
    pub(crate) fn label(&self) -> &str {
        match self {
            Self::File(path) => path,
            Self::Thread { title, .. } => title,
        }
    }
}
impl EventEmitter<MentionQuery> for Composer {}

/// The `@word` the cursor is at the end of: where it starts and what follows
/// the `@`. An address like `me@host` is no mention.
fn mention_at(text: &str, cursor: usize) -> Option<(usize, &str)> {
    let head = text.get(..cursor)?;
    let start = head
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map_or(0, |(index, c)| index + c.len_utf8());
    head[start..].strip_prefix('@').map(|query| (start, query))
}

/// A pick replaces the whole word, not only the part before the cursor.
fn word_end(text: &str, cursor: usize) -> usize {
    text[cursor..]
        .find(char::is_whitespace)
        .map_or(text.len(), |offset| cursor + offset)
}

impl Composer {
    fn mention_token(&self) -> Option<(usize, &str)> {
        if !self.controls.slash.enabled
            || self.composing()
            || self.controls.mention.dismissed.as_ref() == Some(&self.text)
        {
            return None;
        }
        mention_at(&self.text, self.cursor())
    }
    pub(crate) fn mention_suggestions(&self) -> &[MentionResult] {
        if self.controls.mention.query.is_some() {
            &self.controls.mention.results
        } else {
            &[]
        }
    }
    pub(super) fn sync_mention(&mut self, cx: &mut Context<Self>) {
        self.retain_thread_mentions();
        let query = self.mention_token().map(|(_, query)| query.to_owned());
        if query == self.controls.mention.query {
            return;
        }
        let searching = query.is_some();
        self.controls.mention.query = query;
        self.controls.mention.index = 0;
        if searching {
            cx.emit(MentionQuery);
        } else {
            self.controls.mention.results.clear();
            self.controls.mention.search = None;
            cx.emit(Changed(false));
        }
    }
    pub(crate) fn apply_mention(
        &mut self,
        result: &MentionResult,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((start, _)) = self.mention_token() else {
            return;
        };
        let end = word_end(&self.text, self.cursor());
        self.selection = start..end;
        self.insert_prompt(&format!("@{} ", result.label()), cx);
        if let MentionResult::Thread { id, title, .. } = result {
            self.controls
                .mention
                .threads
                .retain(|(_, picked)| picked != id);
            self.controls
                .mention
                .threads
                .push((title.clone(), id.clone()));
        }
        self.focus.focus(window);
    }
    pub(crate) fn dismiss_mention(&mut self, cx: &mut Context<Self>) {
        self.controls.mention.dismissed = Some(self.text.clone());
        self.sync_mention(cx);
    }
    /// Tab takes the highlighted result, as Enter does.
    pub(crate) fn mention_accept(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let results = self.mention_suggestions();
        let Some(path) = results
            .get(
                self.controls
                    .mention
                    .index
                    .min(results.len().saturating_sub(1)),
            )
            .cloned()
        else {
            return false;
        };
        self.apply_mention(&path, window, cx);
        true
    }
    pub(super) fn mention_key(
        &mut self,
        key: &Keystroke,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if key.modifiers.control
            || key.modifiers.platform
            || key.modifiers.alt
            || key.modifiers.shift
        {
            return false;
        }
        let count = self.mention_suggestions().len();
        if count == 0 {
            return false;
        }
        match key.key.as_str() {
            "up" | "down" => {
                let step = if key.key == "up" { count - 1 } else { 1 };
                let index = (self.controls.mention.index + step) % count;
                self.controls.mention.index = index;
                let results = self.mention_suggestions();
                let groups = 1 + usize::from(results[index].group() != results[0].group());
                self.controls.mention.scroll.scroll_to_item(index + groups);
                cx.emit(Changed(false));
                cx.notify();
            }
            "escape" => self.dismiss_mention(cx),
            "enter" => {
                self.mention_accept(window, cx);
            }
            _ => return false,
        }
        cx.stop_propagation();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{mention_at, word_end};

    #[test]
    fn a_pick_reaches_the_end_of_the_word() {
        assert_eq!(word_end("@pack", 4), 5);
        assert_eq!(word_end("@pack and", 4), 5);
        assert_eq!(word_end("@pack", 5), 5);
    }

    #[test]
    fn a_mention_is_the_at_word_the_cursor_ends() {
        assert_eq!(mention_at("@", 1), Some((0, "")));
        assert_eq!(mention_at("read @src/ma", 12), Some((5, "src/ma")));
        assert_eq!(mention_at("read @src now", 13), None);
        assert_eq!(mention_at("write me@host", 13), None);
        assert_eq!(mention_at("é @a", 5), Some((3, "a")));
    }
}

/// Titles match case-insensitively; this project's recent threads lead, and
/// archived threads follow the live ones in each group.
pub(crate) fn thread_matches(
    sessions: &[crate::client::Session],
    current: &str,
    query: &str,
) -> Vec<crate::client::Session> {
    let repo = sessions
        .iter()
        .find(|s| s.id == current)
        .and_then(|s| s.repo_path.as_deref());
    let query = query.to_lowercase();
    let mut threads: Vec<_> = sessions
        .iter()
        .filter(|s| s.id != current && s.title.to_lowercase().contains(&query))
        .collect();
    threads.sort_by(|a, b| {
        (a.repo_path.as_deref() != repo)
            .cmp(&(b.repo_path.as_deref() != repo))
            .then_with(|| (a.status == "archived").cmp(&(b.status == "archived")))
            .then_with(|| b.last_message_at.cmp(&a.last_message_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    threads.into_iter().take(6).cloned().collect()
}

fn contains_title(text: &str, title: &str) -> bool {
    let token = format!("@{title}");
    text.match_indices(&token).any(|(start, _)| {
        text[..start]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace)
            && text[start + token.len()..].chars().next().is_none_or(|c| {
                c.is_whitespace()
                    || matches!(c, ',' | '.' | ';' | ':' | '!' | '?' | ')' | ']' | '}')
            })
    })
}
impl Composer {
    fn retain_thread_mentions(&mut self) {
        self.controls
            .mention
            .threads
            .retain(|(title, _)| contains_title(&self.text, title));
    }
    pub(crate) fn thread_mentions(&mut self) -> Vec<(String, String)> {
        self.retain_thread_mentions();
        self.controls.mention.threads.clone()
    }
}

fn trimmed(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let mut result: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() && limit > 0 {
        result.pop();
        result.push('…');
    }
    result
}
fn escaped(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn attribute(text: &str) -> String {
    escaped(&trimmed(text, 128))
        .replace('"', "&quot;")
        .replace('\n', "&#10;")
        .replace('\r', "&#13;")
}
/// The entire block fits 4,000 characters, including its bounded metadata.
/// Short messages keep their space; the longest lines share the remaining budget.
pub(crate) fn thread_block(
    session: &crate::client::Session,
    history: Result<crate::model::History, String>,
) -> String {
    let header = format!(
        "<mentioned-thread title=\"{}\" status=\"{}\" branch=\"{}\">\n",
        attribute(&session.title),
        attribute(&session.status),
        attribute(session.branch.as_deref().unwrap_or("")),
    );
    let footer = "\n</mentioned-thread>";
    let lines: Vec<String> = match history {
        Ok(history) => history
            .transcript
            .iter()
            .skip(history.transcript.len().saturating_sub(8))
            .map(|entry| escaped(&format!("{}: {}", entry.role, entry.text)))
            .collect(),
        Err(_) => vec!["Context could not be read.".into()],
    };
    let budget =
        4000 - header.chars().count() - footer.chars().count() - lines.len().saturating_sub(1);
    let lengths: Vec<_> = lines.iter().map(|line| line.chars().count()).collect();
    let (mut low, mut high) = (0, budget);
    while low < high {
        let mid = (low + high).div_ceil(2);
        if lengths.iter().map(|len| (*len).min(mid)).sum::<usize>() <= budget {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    let mut remaining = budget - lengths.iter().map(|len| (*len).min(low)).sum::<usize>();
    let lines: Vec<_> = lines
        .iter()
        .zip(lengths)
        .map(|(line, len)| {
            let mut limit = len.min(low);
            if len > limit && remaining > 0 {
                limit += 1;
                remaining -= 1;
            }
            trimmed(line, limit)
        })
        .collect();
    format!("{header}{}{footer}", lines.join("\n"))
}

/// Resolve only the remembered picks, including a thread no longer in the list.
/// Called on the background executor before the queue payload is frozen.
pub(crate) fn thread_context(
    client: &crate::client::Client,
    picks: Vec<(String, String)>,
    sessions: Vec<crate::client::Session>,
    fallback: crate::client::Session,
) -> String {
    picks
        .into_iter()
        .map(|(title, id)| {
            let mut source = sessions
                .iter()
                .find(|s| s.id == id)
                .cloned()
                .unwrap_or_else(|| {
                    let mut source = fallback.clone();
                    source.status = "unknown".into();
                    source.branch = None;
                    source
                });
            source.id = id;
            source.title = title;
            thread_block(&source, client.history(&source.id))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
#[cfg(test)]
#[path = "mention_tests.rs"]
mod thread_tests;
