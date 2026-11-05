//! The "Edited N files" card under a finished turn's answer, ported from
//! classic's ChatActionCard and transcriptTurnFiles. Paths come from the edit
//! tools' own arguments; line counts appear only where the edit itself shows
//! them (an edit's old and new text), never for a whole-file write or a patch.
use crate::model::Row;
use crate::retained::RowState;
use crate::theme::current as theme;
use gpui::{AnyElement, Entity, SharedString, div, prelude::*, px};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Rows shown before "Show N more", as in classic.
const SHOWN: usize = 4;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Edit {
    pub path: String,
    /// (added, removed) lines, when the edit's arguments show both sides.
    pub counts: Option<(u64, u64)>,
}

fn line_count(text: &str) -> u64 {
    let text = text.strip_suffix('\n').unwrap_or(text);
    if text.is_empty() {
        0
    } else {
        text.split('\n').count() as u64
    }
}

/// deriveEditCounts: an Edit's old and new text, or the sum over a MultiEdit.
fn counts(name: &str, args: &Value) -> Option<(u64, u64)> {
    let pair = |edit: &Value| {
        let (old, new) = (edit["old_string"].as_str(), edit["new_string"].as_str());
        (old.is_some() || new.is_some())
            .then(|| (line_count(new.unwrap_or("")), line_count(old.unwrap_or(""))))
    };
    if name.contains("multiedit") {
        let pairs: Vec<_> = args["edits"].as_array()?.iter().filter_map(pair).collect();
        return (!pairs.is_empty()).then(|| {
            pairs
                .iter()
                .fold((0, 0), |sum, (add, del)| (sum.0 + add, sum.1 + del))
        });
    }
    pair(args)
}

/// The files one write-kind tool call edited: its path argument, and each
/// file an apply_patch names.
pub(crate) fn edits(name: &str, args: &Value) -> Vec<Edit> {
    let mut edits = vec![];
    if let Some(path) = ["file_path", "filePath", "path", "notebook_path"]
        .iter()
        .find_map(|key| args[*key].as_str().filter(|path| !path.trim().is_empty()))
    {
        edits.push(Edit {
            path: path.to_owned(),
            counts: counts(name, args),
        });
    }
    if name.contains("apply_patch") {
        let patch = args["patch"].as_str().or(args["input"].as_str());
        for line in patch.unwrap_or("").lines() {
            let path = ["Add File: ", "Update File: ", "Delete File: ", "Move to: "]
                .iter()
                .find_map(|head| line.strip_prefix("*** ")?.strip_prefix(head))
                .map(str::trim)
                .filter(|path| !path.is_empty());
            if let Some(path) = path {
                edits.push(Edit {
                    path: path.to_owned(),
                    counts: None,
                });
            }
        }
    }
    edits
}

/// One row per file; a file edited again sums its counts while every edit
/// was counted, and loses them once one wasn't.
fn merge(files: &mut Vec<Edit>, edit: &Edit) {
    match files.iter_mut().find(|file| file.path == edit.path) {
        Some(file) => {
            file.counts = file
                .counts
                .zip(edit.counts)
                .map(|(a, b)| (a.0 + b.0, a.1 + b.1));
        }
        None => files.push(edit.clone()),
    }
}

/// The files each finished turn edited, keyed by the row its answer ends on
/// (the same rows `transcript_actions::turn_ends` returns).
pub(crate) fn by_turn<T>(
    rows: &[Rc<RefCell<RowState>>],
    ends: &HashMap<usize, T>,
) -> HashMap<usize, Vec<Edit>> {
    let mut out = HashMap::new();
    let mut files = vec![];
    let mut start = 0;
    let mut finish = |files: &mut Vec<Edit>, range: std::ops::Range<usize>| {
        let end = ends.keys().filter(|index| range.contains(*index)).max();
        if let Some(end) = end.filter(|_| !files.is_empty()) {
            out.insert(*end, std::mem::take(files));
        }
        files.clear();
    };
    for (index, row) in rows.iter().enumerate() {
        match &row.borrow().row {
            Row::Message { role, .. } if role != "assistant" => {
                finish(&mut files, start..index);
                start = index;
            }
            Row::PacketHeader { .. } => {
                finish(&mut files, start..index);
                start = index;
            }
            Row::Activity { steps, .. } => {
                for step in steps.iter().filter(|step| step.status == "ok") {
                    for edit in &step.edits {
                        merge(&mut files, edit);
                    }
                }
            }
            _ => {}
        }
    }
    finish(&mut files, start..rows.len());
    out
}

/// A row's folder and file name. A file outside the workspace shows only its
/// parent folder, since the rest of an absolute path is noise.
fn display(path: &str) -> (String, String) {
    let Some((dir, name)) = path.rsplit_once('/') else {
        return (String::new(), path.to_owned());
    };
    let dir = if path.starts_with('/') {
        dir.rsplit('/')
            .next()
            .filter(|parent| !parent.is_empty())
            .map_or("/".to_owned(), |parent| format!("…/{parent}/"))
    } else {
        format!("{dir}/")
    };
    (dir, name.to_owned())
}

/// Whether the Changes list can show this file: a repo path, or an absolute
/// path under the workspace. The server refuses a diff outside it.
fn inside(path: &str, root: Option<&str>) -> bool {
    !path.starts_with('/') || relative(path, root) != path
}

/// The workspace-relative path the Changes list knows a file by.
fn relative<'a>(path: &'a str, root: Option<&str>) -> &'a str {
    root.and_then(|root| path.strip_prefix(root.trim_end_matches('/')))
        .and_then(|rest| rest.strip_prefix('/'))
        .unwrap_or(path)
}

fn counts_label(add: u64, del: u64) -> impl IntoElement {
    div()
        .flex()
        .gap(px(4.))
        .flex_shrink_0()
        .text_size(px(11.))
        .child(div().text_color(theme().success).child(format!("+{add}")))
        .child(div().text_color(theme().danger).child(format!("−{del}")))
}

/// The card: "Edited N files" with Review, then each file; a file opens its
/// diff in Files › Changes.
pub(crate) fn card(
    view: Entity<crate::ui::Surface>,
    turn: String,
    index: usize,
    files: &[Edit],
    root: Option<&str>,
    expanded: bool,
) -> AnyElement {
    let total = files.iter().try_fold((0, 0), |sum, file| {
        file.counts.map(|(add, del)| (sum.0 + add, sum.1 + del))
    });
    let noun = if files.len() == 1 { "file" } else { "files" };
    let open = |path: String| {
        move |_: &gpui::ClickEvent, window: &mut gpui::Window, cx: &mut gpui::App| {
            crate::ui::open_link(&format!("o8-change:{path}"), window, cx);
        }
    };
    let shown = if expanded {
        files.len()
    } else {
        SHOWN.min(files.len())
    };
    let more = files.len() - shown;
    let header = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .h(px(26.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(13.))
                .text_color(theme().text)
                .child(format!("Edited {} {noun}", files.len()))
                .children(total.map(|(add, del)| counts_label(add, del))),
        )
        .children(
            files
                .iter()
                .find(|file| inside(&file.path, root))
                .map(|file| {
                    div()
                        .id(("turn-files-review", index))
                        .debug_selector(move || format!("turn-files-review-{index}"))
                        .px(px(8.))
                        .h(px(24.))
                        .flex()
                        .items_center()
                        .rounded(px(6.))
                        .cursor_pointer()
                        .text_size(px(12.))
                        .text_color(theme().accent)
                        .hover(|d| d.bg(theme().hover))
                        .child("Review")
                        .on_click(open(relative(&file.path, root).to_owned()))
                }),
        );
    let rows = files[..shown].iter().enumerate().map(|(row, file)| {
        let path = relative(&file.path, root);
        let (dir, name) = display(path);
        // A file outside the workspace has no diff to open, so it is a label.
        let reachable = inside(&file.path, root);
        div()
            .id(SharedString::from(format!("turn-files-file-{index}-{row}")))
            .debug_selector(move || format!("turn-files-file-{index}-{row}"))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .h(px(26.))
            .px(px(6.))
            .rounded(px(6.))
            .when(reachable, |row| {
                row.cursor_pointer()
                    .hover(|d| d.bg(theme().hover))
                    .on_click(open(path.to_owned()))
            })
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_size(px(12.))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_color(theme().text_muted)
                            .child(dir),
                    )
                    .child(div().flex_shrink_0().text_color(theme().text).child(name)),
            )
            .children(file.counts.map(|(add, del)| counts_label(add, del)))
    });
    let card = div()
        .debug_selector(move || format!("turn-files-{index}"))
        .w_full()
        .flex()
        .flex_col()
        .gap(px(1.))
        .pl(px(12.))
        .pr(px(6.))
        .py(px(6.))
        .rounded(px(12.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface_raised)
        .child(header)
        .children(rows)
        .when(more > 0, |card| {
            card.child(
                div()
                    .id(("turn-files-more", index))
                    .debug_selector(move || format!("turn-files-more-{index}"))
                    .px(px(6.))
                    .h(px(22.))
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .hover(|d| d.text_color(theme().text))
                    .child(format!("Show {more} more"))
                    .on_click(move |_, _, cx| {
                        view.update(cx, |view, cx| {
                            view.expand_turn_files(turn.clone(), index, cx)
                        });
                    }),
            )
        });
    // In the answer's reading column, like the actions row under it.
    div()
        .w_full()
        .flex()
        .justify_center()
        .child(
            div()
                .w_full()
                .max_w(px(crate::retained::reading_column()))
                .px(px(18.))
                .pt(px(4.))
                .pb(px(6.))
                .child(card),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn edits_read_paths_and_count_only_what_the_edit_shows() {
        let edit = json!({"file_path": "/r/a.rs", "old_string": "x\ny\n", "new_string": "z\n"});
        assert_eq!(
            edits("edit", &edit),
            vec![Edit {
                path: "/r/a.rs".into(),
                counts: Some((1, 2))
            }]
        );
        let multi = json!({"file_path": "b.rs", "edits": [
            {"old_string": "a", "new_string": "b\nc"},
            {"new_string": "d"}
        ]});
        assert_eq!(edits("multiedit", &multi)[0].counts, Some((3, 1)));
        let write = json!({"file_path": "c.md", "content": "hi"});
        assert_eq!(edits("write", &write)[0].counts, None);
        let patch = json!({"input": "*** Begin Patch\n*** Update File: src/d.rs\n@@\n*** Add File: e.rs\n*** End Patch"});
        assert_eq!(
            edits("apply_patch", &patch)
                .iter()
                .map(|e| e.path.as_str())
                .collect::<Vec<_>>(),
            ["src/d.rs", "e.rs"]
        );
    }

    #[test]
    fn a_file_edited_twice_sums_until_an_edit_is_uncounted() {
        let mut files = vec![];
        let counted = Edit {
            path: "a".into(),
            counts: Some((2, 1)),
        };
        merge(&mut files, &counted);
        merge(&mut files, &counted);
        assert_eq!(
            files,
            vec![Edit {
                path: "a".into(),
                counts: Some((4, 2))
            }]
        );
        merge(
            &mut files,
            &Edit {
                path: "a".into(),
                counts: None,
            },
        );
        assert_eq!(files[0].counts, None);
    }

    #[test]
    fn paths_under_the_workspace_become_relative() {
        assert_eq!(relative("/r/src/a.rs", Some("/r")), "src/a.rs");
        assert_eq!(relative("/r/src/a.rs", Some("/r/")), "src/a.rs");
        assert_eq!(relative("/rx/a.rs", Some("/r")), "/rx/a.rs");
        assert_eq!(relative("src/a.rs", Some("/r")), "src/a.rs");
    }

    #[test]
    fn only_files_in_the_workspace_open_a_diff() {
        assert!(inside("src/a.rs", None));
        assert!(inside("/r/src/a.rs", Some("/r")));
        assert!(!inside("/tmp/a.md", Some("/r")));
        assert!(!inside("/r/a.md", None));
    }

    #[test]
    fn each_finished_turn_lists_its_own_files_on_its_answer() {
        let row = |row: Row| Rc::new(RefCell::new(RowState::new(row)));
        let message = |id: &str, role: &str, text: &str| {
            row(Row::Message {
                id: id.into(),
                role: role.into(),
                author: None,
                nodes: crate::text::markdown(text),
            })
        };
        let edit = |id: &str, path: &str, status: &str| {
            crate::activity::activity(
                id,
                &json!({"name": "Edit", "status": status, "args": {
                    "file_path": path, "old_string": "a", "new_string": "b\nc"
                }}),
                "",
            )
        };
        let activity = |id: &str, steps: Vec<crate::activity::Step>| {
            row(Row::Activity {
                id: id.into(),
                steps,
                trace: Default::default(),
            })
        };
        let rows = vec![
            message("u1", "user", "first"),
            activity(
                "a1",
                vec![edit("t1", "a.rs", "done"), edit("t2", "b.rs", "error")],
            ),
            message("m1", "assistant", "one"),
            message("u2", "user", "second"),
            message("m2", "assistant", "nothing edited"),
            message("u3", "user", "third"),
            activity("a3", vec![edit("t3", "c.rs", "done")]),
            message("m3", "assistant", "three"),
        ];
        let ends = crate::transcript_actions::turn_ends(&rows);
        let files = by_turn(&rows, &ends);
        let paths = |index: usize| {
            files[&index]
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(2), ["a.rs"], "a failed edit is not listed");
        assert_eq!(files[&2][0].counts, Some((2, 1)));
        assert!(!files.contains_key(&4), "a turn without edits has no card");
        assert_eq!(paths(7), ["c.rs"]);
    }

    #[test]
    fn rows_show_a_folder_and_a_name() {
        assert_eq!(display("src/ui/a.rs"), ("src/ui/".into(), "a.rs".into()));
        assert_eq!(display("a.rs"), ("".into(), "a.rs".into()));
        assert_eq!(
            display("/tmp/x/demo/a.md"),
            ("…/demo/".into(), "a.md".into())
        );
        assert_eq!(display("/a.md"), ("/".into(), "a.md".into()));
    }
}
