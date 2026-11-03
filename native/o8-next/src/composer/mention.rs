//! `@` in the composer picks a file from the workspace and leaves its path in
//! the text, where the agent reads it. Threads, workers and pills come later
//! (#5305).
use super::*;
use commands::Changed;

#[derive(Default)]
pub(crate) struct Mention {
    pub query: Option<String>,
    pub results: Vec<String>,
    pub index: usize,
    pub dismissed: Option<String>,
    pub scroll: ScrollHandle,
    pub search: Option<gpui::Task<()>>,
}
/// The word after `@` changed, so the results need reading again.
pub(crate) struct MentionQuery;
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
    pub(crate) fn mention_suggestions(&self) -> &[String] {
        if self.controls.mention.query.is_some() {
            &self.controls.mention.results
        } else {
            &[]
        }
    }
    pub(super) fn sync_mention(&mut self, cx: &mut Context<Self>) {
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
        path: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((start, _)) = self.mention_token() else {
            return;
        };
        let end = self.cursor();
        self.selection = start..end;
        self.insert_prompt(&format!("@{path} "), cx);
        self.focus.focus(window);
    }
    pub(crate) fn dismiss_mention(&mut self, cx: &mut Context<Self>) {
        self.controls.mention.dismissed = Some(self.text.clone());
        self.sync_mention(cx);
    }
    /// Tab takes the highlighted file, as Enter does.
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
                self.controls.mention.scroll.scroll_to_item(index);
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
    use super::mention_at;

    #[test]
    fn a_mention_is_the_at_word_the_cursor_ends() {
        assert_eq!(mention_at("@", 1), Some((0, "")));
        assert_eq!(mention_at("read @src/ma", 12), Some((5, "src/ma")));
        assert_eq!(mention_at("read @src now", 13), None);
        assert_eq!(mention_at("write me@host", 13), None);
        assert_eq!(mention_at("é @a", 5), Some((3, "a")));
    }
}
