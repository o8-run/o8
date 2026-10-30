//! The legacy workspace DiffViewer's raw rows, unified wrapping and side pairing.
use super::*;
use std::sync::LazyLock;
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Kind {
    Add,
    Del,
    Context,
    Hunk,
    Meta,
}
#[derive(Clone)]
pub(super) struct Line {
    pub kind: Kind,
    pub text: SharedString,
    pub old: Option<usize>,
    pub new: Option<usize>,
}
pub(super) fn parse(source: &str) -> Vec<Line> {
    static HUNK: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@").unwrap());
    let mut old = 0;
    let mut new = 0;
    source
        .split('\n')
        .map(|text| {
            let (kind, left, right) = if let Some(c) = HUNK.captures(text) {
                old = c[1].parse().unwrap_or(0);
                new = c[2].parse().unwrap_or(0);
                (Kind::Hunk, None, None)
            } else if ["diff --git", "index ", "--- ", "+++ ", "\\ "]
                .iter()
                .any(|prefix| text.starts_with(prefix))
            {
                (Kind::Meta, None, None)
            } else if text.starts_with('+') {
                let n = new;
                new += 1;
                (Kind::Add, None, Some(n))
            } else if text.starts_with('-') {
                let n = old;
                old += 1;
                (Kind::Del, Some(n), None)
            } else {
                let left = (old > 0).then_some(old);
                let right = (new > 0).then_some(new);
                if old > 0 {
                    old += 1;
                }
                if new > 0 {
                    new += 1;
                }
                (Kind::Context, left, right)
            };
            Line {
                kind,
                text: text.replace('\t', "  ").into(),
                old: left,
                new: right,
            }
        })
        .collect()
}
fn tone(kind: Kind) -> (gpui::Rgba, gpui::Rgba) {
    match kind {
        Kind::Add => (theme().success_surface, theme().success),
        Kind::Del => (theme().danger_surface, theme().danger),
        Kind::Hunk => (theme().surface, crate::theme::brand_orange()),
        Kind::Meta => (theme().surface, theme().text_secondary),
        Kind::Context => (crate::theme::CLEAR, theme().text_muted),
    }
}
fn pair(lines: &[Line]) -> Vec<(Option<usize>, Option<usize>)> {
    let mut rows = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind != Kind::Del {
            rows.push(if lines[i].kind == Kind::Add {
                (None, Some(i))
            } else {
                (Some(i), Some(i))
            });
            i += 1;
            continue;
        }
        let start = i;
        while i < lines.len() && lines[i].kind == Kind::Del {
            i += 1;
        }
        let add = i;
        while i < lines.len() && lines[i].kind == Kind::Add {
            i += 1;
        }
        for n in 0..(add - start).max(i - add) {
            rows.push((
                (start + n < add).then_some(start + n),
                (add + n < i).then_some(add + n),
            ));
        }
    }
    rows
}
fn side(line: Option<&Line>, before: bool) -> gpui::AnyElement {
    let (background, color) = line
        .map(|l| tone(l.kind))
        .unwrap_or((crate::theme::CLEAR, theme().text_faint));
    let number = line.and_then(|l| if before { l.old } else { l.new });
    div()
        .flex_1()
        .min_w(px(450.))
        .flex()
        .min_h(px(18.))
        .bg(background)
        .child(
            div()
                .w(px(46.))
                .flex_shrink_0()
                .pr(px(8.))
                .text_align(gpui::TextAlign::Right)
                .text_color(theme().text_faint)
                .child(number.map(|n| n.to_string()).unwrap_or_default()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .whitespace_nowrap()
                .text_color(color)
                .child(line.map(|l| l.text.clone()).unwrap_or(" ".into())),
        )
        .into_any_element()
}
pub(super) fn view(lines: &[Line], split: bool) -> gpui::AnyElement {
    let mut body = div()
        .id(if split {
            "files-diff-side"
        } else {
            "files-diff-unified"
        })
        .debug_selector(move || {
            if split {
                "files-diff-side".into()
            } else {
                "files-diff-unified".into()
            }
        })
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .font_family(theme().font_mono)
        .text_size(px(11.))
        .line_height(px(18.));
    if split {
        body = body.min_w(px(900.));
        for (i, (left, right)) in pair(lines).into_iter().enumerate() {
            body = body.child(
                div()
                    .debug_selector(move || format!("files-diff-row-{i}"))
                    .flex()
                    .min_h(px(18.))
                    .child(side(left.map(|i| &lines[i]), true))
                    .child(side(right.map(|i| &lines[i]), false)),
            );
        }
    } else {
        for (i, line) in lines.iter().enumerate() {
            let (background, color) = tone(line.kind);
            body = body.child(
                div()
                    .debug_selector(move || format!("files-diff-row-{i}"))
                    .w_full()
                    .min_w_0()
                    .flex()
                    .min_h(px(18.))
                    .flex_shrink_0()
                    .bg(background)
                    .child(
                        div()
                            .w(px(52.))
                            .flex_shrink_0()
                            .pr(px(10.))
                            .text_align(gpui::TextAlign::Right)
                            .text_size(px(10.))
                            .text_color(theme().text_faint)
                            .child(
                                line.old
                                    .or(line.new)
                                    .map(|n| n.to_string())
                                    .unwrap_or_default(),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .pr(px(12.))
                            .text_color(color)
                            .child(line.text.clone()),
                    ),
            );
        }
    }
    div()
        .id("files-diff-scroll")
        .flex_1()
        .min_w_0()
        .min_h_0()
        .overflow_scroll()
        .py(px(10.))
        .when(!split, |d| d.pr(px(8.)))
        .child(body)
        .into_any_element()
}
