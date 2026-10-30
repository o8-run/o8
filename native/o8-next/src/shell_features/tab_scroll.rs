use super::*;
use gpui::{Bounds, Pixels, ScrollHandle, ScrollWheelEvent};
use std::cell::RefCell;

struct TabScroll;
register_shell_feature!(TabScroll);
impl ShellFeature for TabScroll {}

/// Shared port of desktop shell/tab-scroll.ts. Scroll positions are view-local.
#[derive(Clone, Default)]
pub(super) struct Strip {
    handle: ScrollHandle,
    target: Rc<Cell<Option<Bounds<Pixels>>>>,
    revealed: Rc<RefCell<Option<(String, Pixels, Pixels)>>>,
}

impl Strip {
    pub(super) fn request_reveal(&self) {
        *self.revealed.borrow_mut() = None;
    }
    /// Measure the selected pill itself, including its close control. Measuring
    /// the pill avoids counting the workspace strip's animated leaving tabs.
    pub(super) fn probe(&self) -> impl IntoElement + use<> {
        let target = self.target.clone();
        canvas(
            move |bounds, _, _| target.set(Some(bounds)),
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0()
    }

    fn edges(&self) -> (bool, bool) {
        let left = -self.handle.offset().x;
        (
            left > px(0.5),
            left < self.handle.max_offset().width - px(0.5),
        )
    }

    /// GPUI deltas point toward the content origin (opposite DOM deltaY).
    /// Keep horizontal trackpad deltas on their native axis. GPUI has pixel
    /// and line events, but no DOM page-mode variant; vertical lines are 16px.
    fn wheel(&self, event: &ScrollWheelEvent, window: &Window) -> bool {
        if event.modifiers.control || event.modifiers.platform {
            return false;
        }
        let delta = event.delta.pixel_delta(px(16.));
        let delta = if delta.x != px(0.) {
            event.delta.pixel_delta(window.line_height()).x
        } else {
            delta.y
        };
        let before = self.handle.offset();
        let next = (before.x + delta).clamp(-self.handle.max_offset().width, px(0.));
        if next == before.x {
            return false;
        }
        self.handle.set_offset(point(next, before.y));
        true
    }

    fn reveal(&self, key: &str) -> bool {
        let viewport = self.handle.bounds();
        let Some(target) = self.target.get() else {
            return false;
        };
        if viewport.size.width <= px(0.) {
            return false;
        }
        let layout = (key.to_owned(), viewport.size.width, target.size.width);
        if self.revealed.borrow().as_ref() == Some(&layout) {
            return false;
        }
        *self.revealed.borrow_mut() = Some(layout);
        let left = target.left() - viewport.left();
        let right = target.right() - viewport.left();
        let inset = ((viewport.size.width - target.size.width) / 2.).clamp(px(0.), px(22.));
        let delta = if target.size.width >= viewport.size.width {
            left
        } else if left < inset {
            left - inset
        } else if right > viewport.size.width - inset {
            right - viewport.size.width + inset
        } else {
            px(0.)
        };
        let before = self.handle.offset();
        let next = (before.x - delta).clamp(-self.handle.max_offset().width, px(0.));
        if next == before.x {
            return false;
        }
        self.handle.set_offset(point(next, before.y));
        true
    }
}

/// Preserve the caller's strip geometry. Hidden overflow plus a tracked handle
/// lets us clamp before consuming an event; GPUI's default scroll handler also
/// scrolls zoom gestures and changes offsets at an already-clamped edge.
pub(super) fn wrap(
    strip: gpui::Stateful<gpui::Div>,
    state: Strip,
    active: Option<String>,
    id: &'static str,
    fade: gpui::Rgba,
    cx: &mut Context<Shell>,
) -> impl IntoElement {
    let (left, right) = state.edges();
    let wheel = state.clone();
    let measure = state.clone();
    let owner = cx.entity().entity_id();
    div()
        .relative()
        .flex_1()
        .min_w_0()
        .h_full()
        .debug_selector(move || format!("{id}-fades-{}{}", u8::from(left), u8::from(right)))
        .child(
            strip
                .overflow_hidden()
                .track_scroll(&state.handle)
                .on_scroll_wheel(cx.listener(move |_, event: &ScrollWheelEvent, window, cx| {
                    if wheel.wheel(event, window) {
                        // Classic leaves horizontal trackpads to native scrolling,
                        // including their normal bubble propagation.
                        if event.delta.pixel_delta(px(16.)).x == px(0.) {
                            cx.stop_propagation();
                        }
                        cx.notify();
                    }
                })),
        )
        .on_children_prepainted(move |_, _, cx| {
            let moved = active.as_deref().is_some_and(|key| measure.reveal(key));
            if moved || measure.edges() != (left, right) {
                cx.notify(owner);
            }
        })
        .children(
            [(left, false), (right, true)]
                .into_iter()
                .filter_map(move |(shown, end)| {
                    shown.then(|| {
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .w(px(18.))
                            .when(end, |edge| edge.right_0())
                            .when(!end, |edge| edge.left_0())
                            .bg(gpui::linear_gradient(
                                if end { 90. } else { 270. },
                                gpui::linear_color_stop(gpui::Rgba { a: 0., ..fade }, 0.),
                                gpui::linear_color_stop(fade, 1.),
                            ))
                    })
                }),
        )
}
