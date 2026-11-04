//! SyntaxFileView's readable fallback and retry, over the bundled diff grammar.
//! Very large files color only the blocks of lines that come into view.
use super::*;
use gpui::{App, Rgba, WeakEntity};
use std::{
    cell::RefCell,
    ops::Range,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
type Rows = Vec<Vec<(Range<usize>, Rgba)>>;
enum Phase {
    Idle,
    Loading,
    Ready(Rc<Rows>),
    Failed,
}
struct State {
    phase: Phase,
    attempt: u64,
}
#[derive(Clone)]
pub(super) struct Colors(Rc<RefCell<State>>);
impl Default for Colors {
    fn default() -> Self {
        Self(Rc::new(RefCell::new(State {
            phase: Phase::Idle,
            attempt: 0,
        })))
    }
}
fn language_path(path: &str) -> String {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let extension = match extension.as_str() {
        "js" | "mjs" | "cjs" | "mts" | "cts" => "ts",
        "jsx" => "tsx",
        "mdx" => "md",
        other => other,
    };
    format!("source.{extension}")
}
fn split(source: &str, spans: Vec<(Range<usize>, Rgba)>) -> Rows {
    let mut offset = 0;
    let mut first = 0;
    source
        .split('\n')
        .map(|line| {
            while first < spans.len() && spans[first].0.end <= offset {
                first += 1;
            }
            let rows = spans[first..]
                .iter()
                .take_while(|(r, _)| r.start < offset + line.len())
                .filter_map(|(r, c)| {
                    let start = r.start.max(offset) - offset;
                    let end = r.end.min(offset + line.len()) - offset;
                    (start < end).then_some((start..end, *c))
                })
                .collect();
            offset += line.len() + 1;
            rows
        })
        .collect()
}
/// Lines parsed together when a file is too large to parse whole.
pub(super) const BLOCK: usize = 2_048;
/// Colored blocks kept; the one farthest from view is dropped first.
const KEPT: usize = 8;
/// A block with more bytes than this (very long lines) stays uncolored, so
/// neither the UI thread nor the parser ever takes the whole file at once.
const BLOCK_BYTES: usize = 1 << 20;
type Block = (usize, Option<Rc<Rows>>, Arc<AtomicBool>);
/// Colors for the blocks of a very large file that have come into view. Each
/// block parses on its own off the UI thread, so a construct that crosses a
/// block edge (a long comment or string) may color differently there.
#[derive(Clone, Default)]
pub(super) struct Blocks(Rc<RefCell<Vec<Block>>>);
impl Blocks {
    /// The line's spans; none until its block is colored, which starts here.
    pub(super) fn line(
        &self,
        line: usize,
        path: &str,
        lines: &[SharedString],
        panel: &WeakEntity<FilesPanel>,
        cx: &mut App,
    ) -> Vec<(Range<usize>, Rgba)> {
        let block = line / BLOCK;
        let found = self
            .0
            .borrow()
            .iter()
            .find(|(b, ..)| *b == block)
            .map(|(_, rows, _)| rows.clone());
        if let Some(rows) = found {
            return rows
                .and_then(|rows| rows.get(line % BLOCK).cloned())
                .unwrap_or_default();
        }
        let start = block * BLOCK;
        let lines = &lines[start..(start + BLOCK).min(lines.len())];
        let dropped = Arc::new(AtomicBool::new(false));
        {
            let mut kept = self.0.borrow_mut();
            if kept.len() >= KEPT {
                let far = (0..kept.len())
                    .max_by_key(|i| kept[*i].0.abs_diff(block))
                    .unwrap_or(0);
                // A parse still queued for a dropped block is skipped.
                kept.swap_remove(far).2.store(true, Ordering::Relaxed);
            }
            let bytes: usize = lines.iter().map(|line| line.len() + 1).sum();
            if bytes > BLOCK_BYTES {
                kept.push((block, Some(Rc::new(vec![])), dropped));
                return vec![];
            }
            kept.push((block, None, dropped.clone()));
        }
        let source = lines
            .iter()
            .map(|s| s.as_ref())
            .collect::<Vec<_>>()
            .join("\n");
        let path = language_path(path);
        let work = cx.background_executor().spawn(async move {
            if dropped.load(Ordering::Relaxed) {
                return vec![];
            }
            // A block that fails to parse stays uncolored, like an unknown language.
            crate::diff::highlight_source(&path, &source)
                .map(|spans| split(&source, spans.unwrap_or_default()))
                .unwrap_or_default()
        });
        let (state, panel) = (self.clone(), panel.clone());
        cx.spawn(async move |cx| {
            let rows = Rc::new(work.await);
            if let Some(entry) = state
                .0
                .borrow_mut()
                .iter_mut()
                .find(|(b, rows, _)| *b == block && rows.is_none())
            {
                entry.1 = Some(rows);
            }
            let _ = panel.update(cx, |_, cx| cx.notify());
        })
        .detach();
        vec![]
    }
}
impl Colors {
    pub(super) fn failed(&self) -> bool {
        matches!(self.0.borrow().phase, Phase::Failed)
    }
    pub(super) fn rows(
        &self,
        path: &str,
        lines: &[SharedString],
        cx: &mut Context<FilesPanel>,
    ) -> Rc<Rows> {
        if matches!(self.0.borrow().phase, Phase::Idle) {
            self.0.borrow_mut().phase = Phase::Loading;
            let attempt = self.0.borrow().attempt;
            let path = language_path(path);
            let source = lines
                .iter()
                .map(|s| s.as_ref())
                .collect::<Vec<_>>()
                .join("\n");
            #[cfg(test)]
            let fail = cx
                .try_global::<super::tests::source_tests::SyntaxFault>()
                .is_some_and(|f| f.0);
            #[cfg(test)]
            if fail {
                cx.global_mut::<super::tests::source_tests::SyntaxFault>().0 = false;
            }
            let work = cx.background_executor().spawn(async move {
                #[cfg(test)]
                if fail {
                    return Err("Syntax colors are unavailable.".to_owned());
                }
                crate::diff::highlight_source(&path, &source)
                    .map(|spans| split(&source, spans.unwrap_or_default()))
            });
            let state = self.clone();
            cx.spawn(async move |this, cx| {
                let result = work.await;
                let _ = this.update(cx, |_, cx| {
                    let mut state = state.0.borrow_mut();
                    if state.attempt != attempt || !matches!(state.phase, Phase::Loading) {
                        return;
                    }
                    state.phase = match result {
                        Ok(rows) => Phase::Ready(Rc::new(rows)),
                        Err(_) => Phase::Failed,
                    };
                    cx.notify();
                });
            })
            .detach();
            let state = self.clone();
            let timer = cx.background_executor().timer(Duration::from_secs(15));
            cx.spawn(async move |this, cx| {
                timer.await;
                let _ = this.update(cx, |_, cx| {
                    let mut state = state.0.borrow_mut();
                    if state.attempt == attempt && matches!(state.phase, Phase::Loading) {
                        state.phase = Phase::Failed;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        match &self.0.borrow().phase {
            Phase::Ready(rows) => rows.clone(),
            _ => Rc::new(vec![]),
        }
    }
    pub(super) fn notice(&self, cx: &mut Context<FilesPanel>) -> impl IntoElement {
        let state = self.clone();
        let key_state = self.clone();
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .p(px(12.))
            .text_size(px(11.))
            .text_color(theme().text_muted)
            .child("Syntax colors are unavailable.")
            .child(
                div()
                    .id("files-syntax-retry")
                    .debug_selector(|| "files-syntax-retry".into())
                    .focusable()
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(px(7.))
                    .border_1()
                    .border_color(theme().border)
                    .cursor_pointer()
                    .hover(|d| d.bg(theme().hover))
                    .active(|d| d.bg(theme().selection))
                    .focus(|d| d.border_color(theme().accent))
                    .child("Retry")
                    .on_click(cx.listener(move |_, _, _, cx| {
                        state.retry();
                        cx.notify();
                    }))
                    .on_key_down(cx.listener(move |_, event: &gpui::KeyDownEvent, _, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            key_state.retry();
                            cx.notify();
                            cx.stop_propagation();
                        }
                    })),
            )
    }
    fn retry(&self) {
        let mut state = self.0.borrow_mut();
        state.attempt += 1;
        state.phase = Phase::Idle;
    }
}
