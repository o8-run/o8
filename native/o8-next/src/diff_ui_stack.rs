//! Review's working changes: every changed file stacked as a collapsible card
//! on the shared diff rows, beside a files drawer that jumps to a file.
use super::*;
use crate::files_panel::file_diff;

const CHEVRON_DOWN: &str = "m6 9 6 6 6-6";
/// Stacked rows are not virtualized, so a file with more diff rows than
/// this starts collapsed.
pub(super) const LARGE: usize = 2_000;
const CHEVRON_RIGHT: &str = "m9 6 6 6-6 6";

/// Each file's hunks, in the order `diff::parse` lists the files: one entry
/// per `diff --git` header, from its first hunk on. A file without hunks
/// (binary, or empty) has none.
pub(super) fn patches(source: &str) -> Vec<String> {
    let mut files: Vec<Vec<&str>> = vec![];
    let mut in_hunks = false;
    for line in source.lines() {
        if line.starts_with("diff --git ") {
            files.push(vec![]);
            in_hunks = false;
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        in_hunks |= line.starts_with("@@");
        if in_hunks {
            file.push(line);
        }
    }
    files.into_iter().map(|lines| lines.join("\n")).collect()
}

/// The shared diff rows for each file, parsed once per load.
pub(super) fn parse(document: &Document) -> Vec<Vec<file_diff::Line>> {
    patches(&document.source)
        .iter()
        .map(|patch| {
            if patch.is_empty() {
                vec![]
            } else {
                file_diff::parse(patch)
            }
        })
        .collect()
}

fn status(file: &diff::File) -> String {
    match file.status.as_str() {
        "deleted" => "removed".into(),
        "renamed" => format!("renamed from {}", file.old_path),
        status => status.into(),
    }
}

impl DiffSurface {
    /// The whole working tree stacks; a single file keeps the virtualized
    /// one-file viewer.
    pub(super) fn stacked(&self) -> bool {
        matches!(self.target, Target::Worktree { file: None, .. })
    }

    /// Jumps the stack to a file and opens it.
    pub(super) fn reveal(&mut self, index: usize, cx: &mut Context<Self>) {
        self.closed.remove(&index);
        self.stack_scroll.scroll_to_item(index);
        cx.notify();
    }

    pub(super) fn stack_view(
        &mut self,
        files: gpui::AnyElement,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let doc = self.document.clone();
        let stack = self.stack.clone();
        let painted = self.painted.clone();
        let mut cards = div()
            .id("diff-stack")
            .debug_selector(|| "diff-stack".into())
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .track_scroll(&self.stack_scroll)
            .flex()
            .flex_col()
            .gap(px(6.))
            .px(px(12.))
            .pb(px(18.));
        for (i, file) in doc.files.iter().enumerate() {
            let open = !self.closed.contains(&i);
            let header = div()
                .id(("diff-stack-file", i))
                .debug_selector(move || format!("diff-stack-file-{i}"))
                .px(px(10.))
                .py(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .cursor_pointer()
                .hover(|h| h.bg(theme().hover))
                .child(crate::icon::stroke(
                    if open { CHEVRON_DOWN } else { CHEVRON_RIGHT },
                    theme().text_muted,
                    12.,
                    1.5,
                ))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_family(theme().font_mono)
                        .text_size(px(11.5))
                        .child(file.path.clone()),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(10.5))
                        .text_color(theme().text_muted)
                        .child(status(file)),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().success)
                        .child(format!("+{}", file.additions)),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().danger)
                        .child(format!("−{}", file.deletions)),
                )
                .on_click(cx.listener(move |s, _, _, cx| {
                    if !s.closed.remove(&i) {
                        s.closed.insert(i);
                    }
                    cx.notify();
                }));
            let mut card = div()
                .flex_shrink_0()
                .rounded(px(10.))
                .border_1()
                .border_color(theme().border)
                .overflow_hidden()
                .child(header);
            if open {
                let body = match stack.get(i).filter(|lines| !lines.is_empty()) {
                    Some(lines) => {
                        let mut scroll = div().id(("diff-stack-body", i)).overflow_x_scroll();
                        // A vertical wheel over a wide file scrolls the stack.
                        scroll.style().restrict_scroll_to_axis = Some(true);
                        scroll
                            .child(file_diff::rows(
                                lines,
                                self.split,
                                &format!("review-file-{i}"),
                            ))
                            .into_any_element()
                    }
                    None => div()
                        .px(px(10.))
                        .py(px(6.))
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child("No text changes to show (binary or empty file).")
                        .into_any_element(),
                };
                card = card.child(div().border_t_1().border_color(theme().border).child(body));
            }
            cards = cards.child(card);
        }
        // Last, so each file card keeps its index for jumps.
        cards = cards.child(
            canvas(
                |_, _, _| (),
                move |_, _, _, _| {
                    painted.borrow_mut().insert(0);
                },
            )
            .size(px(1.)),
        );
        div()
            .flex()
            .flex_1()
            .min_h_0()
            .when(self.drawer, |row| row.child(files))
            .child(cards)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_file_keeps_only_its_hunks_in_document_order() {
        let source = "diff --git a/one.txt b/one.txt\nindex 1..2 100644\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/two.bin b/two.bin\nBinary files differ\ndiff --git a/three.txt b/three.txt\nnew file mode 100644\n--- /dev/null\n+++ b/three.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file";
        assert_eq!(
            patches(source),
            [
                "@@ -1 +1 @@\n-old\n+new",
                "",
                "@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file"
            ]
        );
        let document = crate::diff::parse(source);
        assert_eq!(document.files.len(), patches(source).len());
    }
}
