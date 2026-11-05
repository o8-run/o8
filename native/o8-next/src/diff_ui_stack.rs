//! Review's working changes: every changed file stacked as a collapsible card
//! on the shared diff rows, beside a files drawer that jumps to a file.
//!
//! Stacked rows are not virtualized, so the stack bounds what it draws: an
//! open file draws at most `LARGE` rows, and files open by themselves only
//! while the stack's total stays within `BUDGET`.
use super::*;
use crate::files_panel::file_diff;

const CHEVRON_DOWN: &str = "m6 9 6 6 6-6";
const CHEVRON_RIGHT: &str = "m9 6 6 6-6 6";
/// The most rows one open file draws; a larger file starts closed.
pub(super) const LARGE: usize = 2_000;
/// The most rows the open files draw together without the reader asking.
pub(super) const BUDGET: usize = 6_000;

/// Each file's hunks, in the order `diff::parse` lists the files: one entry
/// per `diff --git` header, from its first hunk on. A file without hunks
/// (binary, a pure rename or a mode change) has none.
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

/// Which files are open. A file the reader opened or closed stays that way;
/// any other opens while it has at most `LARGE` rows and fits what is left
/// of `BUDGET` after the open files above it.
pub(super) fn openness(rows: &[usize], chosen: &[Option<bool>]) -> Vec<bool> {
    let mut spent = 0;
    rows.iter()
        .zip(chosen)
        .map(|(&rows, chosen)| {
            let open = chosen.unwrap_or(rows <= LARGE && spent + rows <= BUDGET);
            if open {
                spent += rows.min(LARGE);
            }
            open
        })
        .collect()
}

/// The files Expand all opens: in order, each one whose drawn rows still fit
/// `BUDGET`.
pub(super) fn fits(rows: &[usize]) -> Vec<bool> {
    let mut spent = 0;
    rows.iter()
        .map(|rows| {
            let drawn = (*rows).min(LARGE);
            let fits = spent + drawn <= BUDGET;
            if fits {
                spent += drawn;
            }
            fits
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

/// Said in place of rows for a file without hunks.
fn no_rows(file: &diff::File) -> String {
    if let Some(binary) = file
        .lines
        .iter()
        .find(|line| line.kind == Kind::Meta && line.text.starts_with("Binary file"))
    {
        return binary.text.clone();
    }
    if file.status == "renamed" {
        return format!("{} → {}", file.old_path, file.path);
    }
    "Metadata-only change".into()
}

fn note(id: (&'static str, usize), selector: String, text: String) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || selector)
        .px(px(10.))
        .py(px(6.))
        .text_size(px(11.))
        .text_color(theme().text_muted)
        .child(text)
}

impl DiffSurface {
    /// The whole working tree stacks; a single file keeps the virtualized
    /// one-file viewer.
    pub(super) fn stacked(&self) -> bool {
        matches!(self.target, Target::Worktree { file: None, .. })
    }

    fn rows(&self) -> Vec<usize> {
        (0..self.document.files.len())
            .map(|i| self.stack.get(i).map_or(0, Vec::len))
            .collect()
    }

    /// Which stacked files are open, in document order.
    pub(crate) fn open_files(&self) -> Vec<bool> {
        let chosen: Vec<Option<bool>> = self
            .document
            .files
            .iter()
            .map(|file| self.chosen.get(&file.path).copied())
            .collect();
        openness(&self.rows(), &chosen)
    }

    /// Every file Expand all would open is open.
    pub(crate) fn all_open(&self) -> bool {
        let open = self.open_files();
        fits(&self.rows())
            .iter()
            .zip(open)
            .all(|(fits, open)| !fits || open)
    }

    pub(super) fn collapse_all(&mut self) {
        for file in self.document.files.iter() {
            self.chosen.insert(file.path.clone(), false);
        }
        self.limit_note = None;
    }

    /// Opens every file that fits the row budget and closes the rest.
    pub(super) fn expand_all(&mut self) {
        let fits = fits(&self.rows());
        for (file, fits) in self.document.files.iter().zip(&fits) {
            self.chosen.insert(file.path.clone(), *fits);
        }
        let (opened, total) = (fits.iter().filter(|f| **f).count(), fits.len());
        self.limit_note = (opened < total).then(|| {
            format!("Opened {opened} of {total} files; the rest would pass {BUDGET} lines")
        });
    }

    fn toggle(&mut self, index: usize) {
        let open = self.open_files().get(index).copied().unwrap_or(false);
        if let Some(file) = self.document.files.get(index) {
            self.chosen.insert(file.path.clone(), !open);
        }
    }

    /// Jumps the stack to a file's header and opens it.
    pub(super) fn reveal(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some(file) = self.document.files.get(index) {
            self.chosen.insert(file.path.clone(), true);
        }
        self.stack_scroll.scroll_to_top_of_item(index);
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
        let opens = self.open_files();
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
            let open = opens[i];
            let lines = stack.get(i).map_or(&[][..], Vec::as_slice);
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
                    s.toggle(i);
                    cx.notify();
                }));
            let mut card = div()
                .flex_shrink_0()
                .rounded(px(10.))
                .border_1()
                .border_color(theme().border)
                .overflow_hidden()
                .child(header);
            let body = if lines.is_empty() {
                open.then(|| {
                    note(
                        ("diff-stack-meta", i),
                        format!("diff-stack-meta-{i}"),
                        no_rows(file),
                    )
                    .into_any_element()
                })
            } else if open {
                let shown = &lines[..lines.len().min(LARGE)];
                let mut scroll = div().id(("diff-stack-body", i)).overflow_x_scroll();
                // A vertical wheel over a wide file scrolls the stack.
                scroll.style().restrict_scroll_to_axis = Some(true);
                let rows = scroll.child(file_diff::rows(
                    shown,
                    self.split,
                    &format!("review-file-{i}"),
                ));
                Some(if shown.len() < lines.len() {
                    div()
                        .child(rows)
                        .child(note(
                            ("diff-stack-more", i),
                            format!("diff-stack-more-{i}"),
                            format!("Showing the first {LARGE} of {} lines.", lines.len()),
                        ))
                        .into_any_element()
                } else {
                    rows.into_any_element()
                })
            } else if !self.chosen.contains_key(&file.path) {
                // Closed by the budget, not the reader: say what opening costs.
                Some(
                    note(
                        ("diff-stack-hint", i),
                        format!("diff-stack-hint-{i}"),
                        format!("{} lines, click to open", lines.len()),
                    )
                    .cursor_pointer()
                    .on_click(cx.listener(move |s, _, _, cx| {
                        s.toggle(i);
                        cx.notify();
                    }))
                    .into_any_element(),
                )
            } else {
                None
            };
            if let Some(body) = body {
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

    #[test]
    fn files_open_by_themselves_only_within_the_row_budget() {
        let none = [None; 6];
        // A large file stays closed; small files open until the budget is spent.
        assert_eq!(
            openness(&[10, LARGE + 1, 1_990, 2_000, 2_000, 1], &none),
            [true, false, true, true, true, false]
        );
        // The reader's choice wins either way, and an opened large file counts
        // only the rows it draws.
        assert_eq!(
            openness(
                &[10, 50_000, 3_000, 1],
                &[Some(false), Some(true), None, None]
            ),
            [false, true, false, true]
        );
    }

    #[test]
    fn expand_all_opens_only_what_fits_the_budget() {
        assert_eq!(fits(&[100, 50_000, 2_000]), [true, true, true]);
        assert_eq!(
            fits(&[2_000, 2_000, 2_000, 10, 1]),
            [true, true, true, false, false]
        );
        assert_eq!(
            fits(&[1_999, 1_999, 1_999, 4, 3]),
            [true, true, true, false, true]
        );
    }
}
