// Zoom and pan for a rendered diagram.
//
// Ported from Pele (https://github.com/obsidianmd/pele), MIT License,
// Copyright (c) 2026 kepano and the Pele contributors.
// Upstream path: src/zoom.ts at commit 3a2f075ee0c3d914f0fad3545fc0f193693975ac.
// The wheel step, the Ctrl/Cmd gate and the pointer-anchored zoom follow it.
// See NOTICE.md and licenses/pele-MIT.txt.
use gpui::{Modifiers, Pixels, Point};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

pub(crate) const MIN_ZOOM: f32 = 0.5;
pub(crate) const MAX_ZOOM: f32 = 3.;

/// Where a diagram's drawing sits in its card: `apply` maps a drawing point to
/// the card body.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Viewport {
    pub zoom: f32,
    pub pan: (f32, f32),
}
impl Default for Viewport {
    fn default() -> Self {
        Self {
            zoom: 1.,
            pan: (0., 0.),
        }
    }
}
impl Viewport {
    pub(crate) fn apply(&self, (x, y): (f32, f32)) -> (f32, f32) {
        (self.pan.0 + x * self.zoom, self.pan.1 + y * self.zoom)
    }
    /// Scales by `factor`, keeping the drawing point under `at` where it is.
    pub(crate) fn zoom_at(&mut self, factor: f32, at: (f32, f32)) {
        if !factor.is_finite() || factor <= 0. {
            return;
        }
        let zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        let k = zoom / self.zoom;
        self.pan = (
            at.0 - (at.0 - self.pan.0) * k,
            at.1 - (at.1 - self.pan.1) * k,
        );
        self.zoom = zoom;
    }
    /// A wheel turn in pixels, positive toward the reader. A mouse notch is a
    /// large step and a trackpad pinch many small ones, so each is capped.
    pub(crate) fn wheel(&mut self, delta: f32, at: (f32, f32)) {
        self.zoom_at(2f32.powf(delta.clamp(-24., 24.) * 0.02), at);
    }
    pub(crate) fn drag(&mut self, dx: f32, dy: f32) {
        self.pan = (self.pan.0 + dx, self.pan.1 + dy);
    }
    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }
}
/// Without Ctrl or Cmd the wheel belongs to the transcript.
pub(crate) fn zooms(modifiers: &Modifiers) -> bool {
    modifiers.control || modifiers.platform
}

#[derive(Default)]
struct State {
    views: BTreeMap<usize, Viewport>,
    drag: Option<(usize, Point<Pixels>)>,
}
/// A row's diagram viewports by diagram index. The row keeps them across
/// relayouts, so a reply that is still streaming keeps the reader's zoom.
#[derive(Clone, Default)]
pub(crate) struct Views(Rc<RefCell<State>>);
impl Views {
    pub(crate) fn get(&self, index: usize) -> Viewport {
        self.0
            .borrow()
            .views
            .get(&index)
            .copied()
            .unwrap_or_default()
    }
    pub(crate) fn update(&self, index: usize, f: impl FnOnce(&mut Viewport)) {
        let mut state = self.0.borrow_mut();
        let view = state.views.entry(index).or_default();
        f(view);
        if *view == Viewport::default() {
            state.views.remove(&index);
        }
    }
    pub(crate) fn dragging(&self, index: usize) -> bool {
        self.0.borrow().drag.is_some_and(|(i, _)| i == index)
    }
    pub(crate) fn start_drag(&self, index: usize, at: Point<Pixels>) {
        self.0.borrow_mut().drag = Some((index, at));
    }
    pub(crate) fn drag_to(&self, index: usize, at: Point<Pixels>) {
        let Some((_, from)) = self.0.borrow().drag.filter(|(i, _)| *i == index) else {
            return;
        };
        self.update(index, |view| {
            view.drag(f32::from(at.x - from.x), f32::from(at.y - from.y))
        });
        self.0.borrow_mut().drag = Some((index, at));
    }
    pub(crate) fn end_drag(&self) {
        self.0.borrow_mut().drag = None;
    }
}
