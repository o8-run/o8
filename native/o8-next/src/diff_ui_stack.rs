//! Review's working changes: every changed file stacked as a collapsible row
//! on the shared diff rows, beside a files drawer that jumps to a file. As in
//! classic Review, the files are a flat list and long lines wrap.
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
/// The files drawer's width.
pub(super) const DRAWER: gpui::Pixels = px(210.);
/// Narrower than this, the drawer starts hidden and opens over the stack.
const NARROW: gpui::Pixels = px(640.);
/// The stack never gets narrower than this beside the drawer.
const STACK_MIN: gpui::Pixels = px(220.);

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

/// What a file's row says besides its counts; a plain modification says
/// nothing, as in classic.
fn status(file: &diff::File) -> Option<String> {
    match file.status.as_str() {
        "modified" => None,
        "deleted" => Some("removed".into()),
        "renamed" => Some(format!("renamed from {}", file.old_path)),
        status => Some(status.into()),
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

fn files_column(files: gpui::AnyElement) -> gpui::Div {
    div()
        .debug_selector(|| "diff-drawer-column".into())
        .w(DRAWER)
        .flex_shrink_0()
        .h_full()
        .border_r_1()
        .border_color(theme().border)
        .child(files)
}

impl DiffSurface {
    /// The whole working tree stacks; a single file keeps the virtualized
    /// one-file viewer.
    pub(super) fn stacked(&self) -> bool {
        matches!(self.target, Target::Worktree { file: None, .. })
    }

    /// Each shown file's rows, in the order `shown` lists them.
    fn rows(&self, shown: &[usize]) -> Vec<usize> {
        shown
            .iter()
            .map(|i| self.stack.get(*i).map_or(0, Vec::len))
            .collect()
    }

    /// Which files are open, by document index; a file the scope hides is
    /// closed and spends none of the budget.
    pub(crate) fn open_files(&self) -> Vec<bool> {
        let shown = self.shown();
        let chosen: Vec<Option<bool>> = shown
            .iter()
            .map(|i| self.chosen.get(&self.document.files[*i].path).copied())
            .collect();
        let mut open = vec![false; self.document.files.len()];
        for (i, is_open) in shown.iter().zip(openness(&self.rows(&shown), &chosen)) {
            open[*i] = is_open;
        }
        open
    }

    /// Every shown file Expand all would open is open.
    pub(crate) fn all_open(&self) -> bool {
        let (shown, open) = (self.shown(), self.open_files());
        fits(&self.rows(&shown))
            .iter()
            .zip(&shown)
            .all(|(fits, i)| !fits || open[*i])
    }

    pub(super) fn collapse_all(&mut self) {
        for i in self.shown() {
            self.chosen
                .insert(self.document.files[i].path.clone(), false);
        }
        self.limit_note = None;
    }

    /// Opens every shown file that fits the row budget and closes the rest.
    pub(super) fn expand_all(&mut self) {
        let shown = self.shown();
        let fits = fits(&self.rows(&shown));
        for (i, fits) in shown.iter().zip(&fits) {
            self.chosen
                .insert(self.document.files[*i].path.clone(), *fits);
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
        self.limit_note = None;
    }

    fn narrow(&self) -> bool {
        self.width > px(0.) && self.width < NARROW
    }

    pub(crate) fn drawer_shown(&self) -> bool {
        self.drawer.unwrap_or(!self.narrow())
    }

    /// Jumps the stack to a shown file's header; `open` also opens it.
    /// Walking the list with the keyboard moves without opening.
    pub(super) fn reveal(&mut self, index: usize, open: bool, cx: &mut Context<Self>) {
        let Some(position) = self.shown().iter().position(|i| *i == index) else {
            return;
        };
        if open {
            self.chosen
                .insert(self.document.files[index].path.clone(), true);
            self.limit_note = None;
        }
        // Cards are the stack's children in `shown` order.
        self.stack_scroll.scroll_to_top_of_item(position);
        cx.notify();
    }

    /// A file picked in the drawer: in the stack, it opens; over a narrow
    /// stack, the drawer then gets out of the way.
    pub(super) fn pick(&mut self, index: usize, cx: &mut Context<Self>) {
        self.select_file(index, cx);
        if self.stacked() {
            self.reveal(self.selected, true, cx);
            if self.narrow() {
                self.drawer = None;
            }
        }
    }

    /// Shows one file of the working changes in the virtualized one-file
    /// view, where every row can be reached.
    pub(crate) fn open_full(&mut self, index: usize, cx: &mut Context<Self>) {
        let (Some(file), Target::Worktree { path, base, .. }) =
            (self.document.files.get(index), &self.target)
        else {
            return;
        };
        let full = Target::Worktree {
            path: path.clone(),
            base: base.clone(),
            file: Some(file.path.clone()),
        };
        self.stack_target = Some(std::mem::replace(&mut self.target, full));
        self.load(cx);
    }

    pub(super) fn back_to_stack(&mut self, cx: &mut Context<Self>) {
        if let Some(target) = self.stack_target.take() {
            self.target = target;
            self.load(cx);
        }
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
        let (narrow, drawer) = (self.narrow(), self.drawer_shown());
        let shown = self.shown();
        let mut cards = div()
            .id("diff-stack")
            .debug_selector(|| "diff-stack".into())
            .flex_1()
            // Beside the drawer the stack keeps a usable width; a narrow pane
            // gives it all of its width and lays the drawer over it.
            .min_w(if narrow { px(0.) } else { STACK_MIN })
            .h_full()
            .overflow_y_scroll()
            .track_scroll(&self.stack_scroll)
            .flex()
            .flex_col()
            .pb(px(18.));
        if shown.is_empty() && self.scope != Scope::All {
            cards = cards.child(note(
                ("diff-scope-empty", 0),
                "diff-scope-empty".into(),
                self.scope_note(),
            ));
        }
        for &i in &shown {
            let file = &doc.files[i];
            let open = opens[i];
            let lines = stack.get(i).map_or(&[][..], Vec::as_slice);
            let header = div()
                .id(("diff-stack-file", i))
                .debug_selector(move || format!("diff-stack-file-{i}"))
                .pl(px(12.))
                .pr(px(14.))
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
                        .text_size(px(12.))
                        .child(file.path.clone()),
                )
                .children(status(file).map(|status| {
                    div()
                        .flex_shrink_0()
                        .text_size(px(10.))
                        .text_color(theme().text_faint)
                        .child(status)
                }))
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
                .border_b_1()
                .border_color(theme().border)
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
                // Long lines wrap inside the pane, so nothing scrolls sideways.
                let rows = div()
                    .id(("diff-stack-body", i))
                    .child(file_diff::wrapped_rows(
                        shown,
                        self.split,
                        &format!("review-file-{i}"),
                    ));
                Some(if shown.len() < lines.len() {
                    div()
                        .child(rows)
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(note(
                                    ("diff-stack-more", i),
                                    format!("diff-stack-more-{i}"),
                                    format!("Showing the first {LARGE} of {} lines.", lines.len()),
                                ))
                                .child(
                                    note(
                                        ("diff-stack-full", i),
                                        format!("diff-stack-full-{i}"),
                                        "Open full file".into(),
                                    )
                                    .text_color(theme().accent)
                                    .cursor_pointer()
                                    .on_click(cx.listener(move |s, _, _, cx| s.open_full(i, cx))),
                                ),
                        )
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
        // Last, so each card's position matches `shown` for jumps.
        cards = cards.child(
            canvas(
                |_, _, _| (),
                move |_, _, _, _| {
                    painted.borrow_mut().insert(0);
                },
            )
            .size(px(1.)),
        );
        let measured = cx.entity().downgrade();
        let column = drawer.then(|| files_column(files));
        let (beside, over) = if narrow {
            (None, column)
        } else {
            (column, None)
        };
        div()
            .relative()
            .flex()
            .flex_1()
            .min_h_0()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, _, cx| {
                        let _ = measured.update(cx, |this, cx| {
                            let width = bounds.size.width.floor();
                            if this.width != width {
                                this.width = width;
                                cx.notify();
                            }
                        });
                    },
                )
                .absolute()
                .size_full(),
            )
            .children(beside)
            .child(cards)
            .when_some(over, |row, column| {
                // Over a narrow stack the drawer opens on top of it, opaque
                // even in a glass window, whose background is see-through.
                row.child(
                    column
                        .absolute()
                        .top_0()
                        .left_0()
                        .bottom_0()
                        .bg(crate::theme::popover_background())
                        .shadow_md()
                        .occlude(),
                )
            })
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
