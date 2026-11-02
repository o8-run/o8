//! Selection and copy for virtual source rows; clipboard bytes keep source tabs.
use super::*;
use gpui::{Bounds, Pixels, Point, Rgba, TextLayout, TextRun};
use std::{cell::RefCell, ops::Range, rc::Rc};
#[derive(Default)]
struct State {
    raw: String,
    display: String,
    raw_offsets: Vec<usize>,
    offsets: Vec<usize>,
    range: Range<usize>,
    anchor: usize,
    dragging: bool,
    layouts: Vec<(usize, TextLayout)>,
}
#[derive(Clone, Default)]
pub(super) struct Selection(Rc<RefCell<State>>);
impl Selection {
    pub(super) fn configure(&self, raw: &str) {
        let mut s = self.0.borrow_mut();
        if s.raw != raw || s.offsets.is_empty() {
            s.raw = raw.into();
            s.display = raw.replace('\t', "  ");
            s.range = 0..0;
            s.anchor = 0;
            let offsets = |text: &str| {
                let mut at = 0;
                text.split('\n')
                    .map(|line| {
                        let start = at;
                        at += line.len() + 1;
                        start
                    })
                    .collect()
            };
            s.raw_offsets = offsets(&s.raw);
            s.offsets = offsets(&s.display);
        }
        s.layouts.clear();
    }
    pub(super) fn register(&self, row: usize, layout: TextLayout) {
        self.0.borrow_mut().layouts.push((row, layout));
    }
    fn at(&self, point: Point<Pixels>) -> usize {
        let s = self.0.borrow();
        let row = s.layouts.iter().min_by(|(_, a), (_, b)| {
            let distance = |bounds: Bounds<Pixels>| {
                if point.y < bounds.top() {
                    bounds.top() - point.y
                } else if point.y > bounds.bottom() {
                    point.y - bounds.bottom()
                } else {
                    gpui::px(0.)
                }
            };
            distance(a.bounds())
                .partial_cmp(&distance(b.bounds()))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        match row {
            Some((row, layout)) => {
                let i = layout.index_for_position(point).unwrap_or_else(|i| i);
                (s.offsets[*row] + i).min(s.display.len())
            }
            None => 0,
        }
    }
    pub(super) fn begin(&self, point: Point<Pixels>, shift: bool) {
        let index = self.at(point);
        let mut s = self.0.borrow_mut();
        if !shift {
            s.anchor = index;
        }
        s.range = s.anchor.min(index)..s.anchor.max(index);
        s.dragging = true;
    }
    pub(super) fn drag(&self, point: Point<Pixels>) -> bool {
        if !self.0.borrow().dragging {
            return false;
        }
        let index = self.at(point);
        let mut s = self.0.borrow_mut();
        s.range = s.anchor.min(index)..s.anchor.max(index);
        true
    }
    pub(super) fn end(&self) {
        self.0.borrow_mut().dragging = false;
    }
    pub(super) fn all(&self) {
        let mut s = self.0.borrow_mut();
        s.anchor = 0;
        s.range = 0..s.display.len();
    }
    pub(super) fn clear(&self) {
        self.0.borrow_mut().range = 0..0;
    }
    pub(super) fn copy(&self) -> Option<String> {
        let s = self.0.borrow();
        if s.range.is_empty() {
            return None;
        }
        let raw_index = |index: usize| {
            let row = s
                .offsets
                .partition_point(|start| *start <= index)
                .saturating_sub(1);
            let raw_start = s.raw_offsets[row];
            let raw_line = s.raw[raw_start..].split('\n').next().unwrap_or("");
            let display = index - s.offsets[row];
            let mut shift = 0;
            let mut n = 0;
            for (at, byte) in raw_line.bytes().enumerate() {
                if byte == b'\t' {
                    if display > at + n {
                        shift += 1;
                    }
                    n += 1;
                }
            }
            raw_start + display.saturating_sub(shift).min(raw_line.len())
        };
        Some(s.raw[raw_index(s.range.start)..raw_index(s.range.end)].into())
    }
    pub(super) fn runs(
        &self,
        row: usize,
        text: &str,
        colors: &[(Range<usize>, Rgba)],
    ) -> Vec<TextRun> {
        let s = self.0.borrow();
        let offset = s.offsets[row];
        let selected = s.range.start.max(offset).saturating_sub(offset)
            ..s.range.end.min(offset + text.len()).saturating_sub(offset);
        let mut boundaries = vec![0, text.len()];
        for (range, _) in colors {
            boundaries.extend([range.start, range.end]);
        }
        if selected.start < selected.end {
            boundaries.extend([selected.start, selected.end]);
        }
        boundaries.sort_unstable();
        boundaries.dedup();
        let mut at = 0;
        boundaries
            .windows(2)
            .map(|span| {
                while at < colors.len() && colors[at].0.end <= span[0] {
                    at += 1;
                }
                let color = colors
                    .get(at)
                    .filter(|(r, _)| r.contains(&span[0]))
                    .map(|(_, c)| *c)
                    .unwrap_or(theme().text);
                TextRun {
                    len: span[1] - span[0],
                    font: gpui::font(theme().font_mono),
                    color: color.into(),
                    background_color: (span[0] >= selected.start && span[0] < selected.end)
                        .then(|| theme().selection.into()),
                    underline: None,
                    strikethrough: None,
                }
            })
            .collect()
    }
}
