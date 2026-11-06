//! Marks an attached image before it is sent: arrow, box, pen, highlight and
//! draggable text cards in six colors, with ⌘Z undo and Esc to cancel. Done
//! composites the marks into the image off the paint thread and replaces the
//! attachment. A native port of the desktop composer's screenshot annotator.
use super::Composer;
use crate::theme::current as theme;
use gpui::{
    AnyElement, App, Bounds, Context, Entity, EventEmitter, FocusHandle, KeyDownEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, PathBuilder, Pixels, Point, Render, RenderImage,
    Rgba, SharedString, Window, canvas, div, img, point, prelude::*, px, rgb, rgba,
};
use std::{cell::Cell, rc::Rc, sync::Arc};

use crate::theme::annotate::{CARD_INK, CARD_PAPER, GRIP_BUTTON, GRIP_MARK, HINT, PALETTE, SCRIM};

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Tool {
    Arrow,
    Box,
    Pen,
    Highlight,
    Text,
}
const TOOLS: [(Tool, &str, &str); 5] = [
    (Tool::Arrow, "arrow", "M7 17 17 7 M8 7h9v9"),
    (
        Tool::Box,
        "box",
        "M6 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
    ),
    (
        Tool::Pen,
        "pen",
        "M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
    ),
    (
        Tool::Highlight,
        "highlight",
        "m9 11-6 6v3h3l6-6 m14 5 5 5 M13 6 18 1l5 5-5 5Z",
    ),
    (Tool::Text, "text", "M4 7V5h16v2 M9 19h6 M12 5v14"),
];
const UNDO: &str = "M9 14 4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-4";
const GRIP: &str = "M7 8h10 M7 12h10 M7 16h10";
const CLOSE: &str = "M6 6l12 12 M18 6L6 18";

/// Marks in image pixels.
#[derive(Clone, Debug)]
pub(crate) enum Shape {
    Arrow {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        color: usize,
        width: f32,
    },
    Box {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        color: usize,
        width: f32,
    },
    Highlight {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        color: usize,
    },
    Pen {
        points: Vec<(f32, f32)>,
        color: usize,
        width: f32,
    },
}
impl Shape {
    fn extend(&mut self, x: f32, y: f32) {
        match self {
            Shape::Pen { points, .. } => points.push((x, y)),
            Shape::Arrow { x2, y2, .. }
            | Shape::Box { x2, y2, .. }
            | Shape::Highlight { x2, y2, .. } => (*x2, *y2) = (x, y),
        }
    }
}

struct Card {
    x: f32,
    y: f32,
    color: usize,
    input: Entity<Composer>,
    /// The baked box in image pixels, re-measured as the text changes.
    size: (f32, f32),
}

/// How the editor closed.
pub(crate) enum Finished {
    Cancelled,
    /// The attachment at `index`, still `from`, becomes `uri`.
    Done {
        index: usize,
        from: String,
        uri: String,
    },
}

const PLACEHOLDER: &str = "Type here";

pub(crate) struct Annotator {
    index: usize,
    uri: String,
    preview: Arc<RenderImage>,
    width: f32,
    height: f32,
    /// The desktop's stroke: a 350th of the image width, at least 3 pixels.
    stroke: f32,
    pub(crate) tool: Tool,
    pub(crate) color: usize,
    pub(crate) shapes: Vec<Shape>,
    draft: Option<Shape>,
    cards: Vec<Card>,
    /// A card being moved, and where it was grabbed relative to its corner.
    drag: Option<(usize, f32, f32)>,
    stage: Rc<Cell<Bounds<Pixels>>>,
    pub(crate) focus: FocusHandle,
    pub(crate) busy: bool,
    pub(crate) error: Option<String>,
}
impl EventEmitter<Finished> for Annotator {}

impl Annotator {
    pub(crate) fn new(
        index: usize,
        uri: String,
        preview: Arc<RenderImage>,
        cx: &mut Context<Self>,
    ) -> Self {
        let size = preview.size(0);
        let (width, height) = (size.width.0.max(1) as f32, size.height.0.max(1) as f32);
        // Cards measure with the bake's fonts; load them before the first note.
        cx.background_executor()
            .spawn(async { super::annotate_raster::warm_fonts() })
            .detach();
        Self {
            index,
            uri,
            preview,
            width,
            height,
            stroke: (width / 350.).round().max(3.),
            tool: Tool::Arrow,
            color: 0,
            shapes: vec![],
            draft: None,
            cards: vec![],
            drag: None,
            stage: Rc::new(Cell::new(Bounds::default())),
            focus: cx.focus_handle(),
            busy: false,
            error: None,
        }
    }
    #[cfg(test)]
    pub(crate) fn card_count(&self) -> usize {
        self.cards.len()
    }
    /// Window position to image pixels, clamped to the image.
    fn to_image(&self, position: Point<Pixels>) -> (f32, f32) {
        let stage = self.stage.get();
        let scale = f32::from(stage.size.width).max(1.) / self.width;
        let x = (f32::from(position.x - stage.origin.x) / scale).clamp(0., self.width);
        let y = (f32::from(position.y - stage.origin.y) / scale).clamp(0., self.height);
        (x, y)
    }
    fn down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        cx.stop_propagation();
        if self.busy {
            return;
        }
        let (x, y) = self.to_image(event.position);
        let (color, width) = (self.color, self.stroke);
        self.draft = match self.tool {
            Tool::Text => {
                let input = cx.new(|cx| {
                    let mut input = Composer::new(cx);
                    input.placeholder = PLACEHOLDER.into();
                    input.newline_on_enter = true;
                    // No frame: the card is the frame, as in the bake.
                    input.inline = true;
                    input
                });
                input.read(cx).focus.focus(window);
                // Typing re-measures the card.
                cx.observe(&input, |this: &mut Self, input, cx| {
                    let text = input.read(cx).text.clone();
                    // A blank card holds room for its placeholder.
                    let text = if text.trim().is_empty() {
                        PLACEHOLDER.into()
                    } else {
                        text
                    };
                    let width = this.width;
                    if let Some(card) = this.cards.iter_mut().find(|c| c.input == input) {
                        card.size = super::annotate_raster::card_size(&text, width);
                    }
                    cx.notify();
                })
                .detach();
                let size = super::annotate_raster::card_size(PLACEHOLDER, self.width);
                self.cards.push(Card {
                    x,
                    y,
                    color,
                    input,
                    size,
                });
                None
            }
            Tool::Arrow => Some(Shape::Arrow {
                x1: x,
                y1: y,
                x2: x,
                y2: y,
                color,
                width,
            }),
            Tool::Box => Some(Shape::Box {
                x1: x,
                y1: y,
                x2: x,
                y2: y,
                color,
                width,
            }),
            Tool::Highlight => Some(Shape::Highlight {
                x1: x,
                y1: y,
                x2: x,
                y2: y,
                color,
            }),
            Tool::Pen => Some(Shape::Pen {
                points: vec![(x, y)],
                color,
                width,
            }),
        };
        if self.tool != Tool::Text {
            self.focus.focus(window);
        }
        cx.notify();
    }
    fn moved(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        let (x, y) = self.to_image(event.position);
        if let Some((card, dx, dy)) = self.drag {
            if let Some(card) = self.cards.get_mut(card) {
                card.x = (x - dx).clamp(0., self.width);
                card.y = (y - dy).clamp(0., self.height);
            }
            cx.notify();
        } else if let Some(draft) = &mut self.draft {
            draft.extend(x, y);
            cx.notify();
        }
    }
    fn up(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.drag = None;
        if let Some(draft) = self.draft.take() {
            self.shapes.push(draft);
        }
        cx.notify();
    }
    pub(crate) fn undo(&mut self, cx: &mut Context<Self>) {
        if self.shapes.pop().is_some() {
            cx.notify();
        }
    }
    pub(crate) fn cancel(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            cx.emit(Finished::Cancelled);
        }
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let typing = !self.focus.is_focused(window);
        if key == "escape" {
            cx.stop_propagation();
            // Esc in a text card leaves the card; Esc on the image closes the editor.
            if typing {
                self.focus.focus(window);
                cx.notify();
            } else {
                self.cancel(cx);
            }
        } else if key == "z"
            && event.keystroke.modifiers.secondary()
            && !event.keystroke.modifiers.shift
            && !typing
        {
            cx.stop_propagation();
            self.undo(cx);
        }
    }
    pub(crate) fn done(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(bytes) = super::images::data_uri_bytes(&self.uri) else {
            self.error = Some("Could not read the image.".into());
            cx.notify();
            return;
        };
        if self.shapes.is_empty()
            && self
                .cards
                .iter()
                .all(|c| c.input.read(cx).text.trim().is_empty())
        {
            cx.emit(Finished::Cancelled);
            return;
        }
        self.busy = true;
        self.error = None;
        let shapes = self.shapes.clone();
        let cards: Vec<_> = self
            .cards
            .iter()
            .map(|card| super::annotate_raster::Card {
                x: card.x,
                y: card.y,
                color: card.color,
                text: card.input.read(cx).text.clone(),
            })
            .collect();
        let task = cx
            .background_executor()
            .spawn(async move { super::annotate_raster::composite(&bytes, &shapes, &cards) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(uri) => cx.emit(Finished::Done {
                        index: this.index,
                        from: this.uri.clone(),
                        uri,
                    }),
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn button(id: &str, active: bool) -> gpui::Stateful<gpui::Div> {
        let selector = id.to_owned();
        div()
            .id(SharedString::from(id.to_owned()))
            .debug_selector(move || selector.clone())
            .h(px(30.))
            .min_w(px(30.))
            .px(px(7.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.))
            .cursor_pointer()
            .when(active, |b| b.bg(theme().selection))
            .hover(|b| b.bg(theme().hover))
    }
    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let icon = |path: &str, color: Rgba| crate::icon::stroke(path, color, 16., 1.8);
        div()
            .debug_selector(|| "annotator-toolbar".into())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .flex()
            .flex_wrap()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .px(px(10.))
            .py(px(8.))
            .rounded(px(14.))
            // Opaque, so nothing under the editor shows through the tools.
            .bg(crate::theme::popover_background())
            .border_1()
            .border_color(theme().border)
            .shadow_lg()
            .child(
                div()
                    .flex()
                    .gap(px(4.))
                    .children(TOOLS.map(|(tool, name, path)| {
                        Self::button(&format!("annotator-tool-{name}"), self.tool == tool)
                            .child(icon(path, theme().text))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.tool = tool;
                                cx.notify();
                            }))
                    })),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .px(px(8.))
                    .children((0..PALETTE.len()).map(|color| {
                        let on = self.color == color;
                        div()
                            .id(("annotator-color", color))
                            .debug_selector(move || format!("annotator-color-{color}"))
                            .size(px(20.))
                            .rounded_full()
                            .bg(rgb(PALETTE[color]))
                            .when(on, |d| d.border_2().border_color(theme().text))
                            .when(!on, |d| d.border_1().border_color(theme().border))
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.color = color;
                                cx.notify();
                            }))
                    })),
            )
            .child(
                div()
                    .flex()
                    .gap(px(4.))
                    .child(
                        Self::button("annotator-undo", false)
                            .opacity(if self.shapes.is_empty() { 0.4 } else { 1. })
                            .child(icon(UNDO, theme().text))
                            .on_click(cx.listener(|this, _, _, cx| this.undo(cx))),
                    )
                    .child(
                        Self::button("annotator-cancel", false)
                            .text_color(theme().text_muted)
                            .child("Cancel")
                            .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                    )
                    .child(
                        Self::button("annotator-done", false)
                            .bg(theme().accent)
                            .text_color(crate::theme::on_accent())
                            .opacity(if self.busy { 0.6 } else { 1. })
                            .child(if self.busy { "Saving…" } else { "Done" })
                            .on_click(cx.listener(|this, _, _, cx| this.done(cx))),
                    ),
            )
    }
    fn card(&self, index: usize, scale: f32, cx: &mut Context<Self>) -> AnyElement {
        let card = &self.cards[index];
        let color = rgb(PALETTE[card.color]);
        // The bake's own numbers times the stage scale: what shows is what saves.
        let m = super::annotate_raster::card_metrics(self.width);
        let (w, h) = card.size;
        let border = m.border * scale;
        // SVG text sits a font's ascent (0.8) below the padding; a line box of
        // `line_h` centres the glyphs, so start it that much higher.
        let lead = (m.line_h - m.font) / 2.;
        div()
            .id(("annotator-card", index))
            .debug_selector(move || format!("annotator-card-{index}"))
            .absolute()
            .left(px(card.x * scale))
            .top(px(card.y * scale))
            .w(px(w * scale))
            .h(px(h * scale))
            .rounded(px(m.radius * scale))
            .border(px(border))
            .border_color(color)
            .bg(rgba(CARD_PAPER))
            .shadow_lg()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                // Editor-only chrome above the box, so it never moves the text.
                div()
                    .id(("annotator-card-grip", index))
                    .debug_selector(move || format!("annotator-card-grip-{index}"))
                    .absolute()
                    .left(px(-border))
                    .bottom(px(h * scale - border + 2.))
                    .min_w(px(56.))
                    .w(px(w * scale))
                    .rounded_t(px(6.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(6.))
                    .py(px(3.))
                    .bg(color)
                    .cursor_grab()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            let (x, y) = this.to_image(event.position);
                            if let Some(card) = this.cards.get(index) {
                                this.drag = Some((index, x - card.x, y - card.y));
                            }
                        }),
                    )
                    .child(crate::icon::stroke(GRIP, rgba(GRIP_MARK), 13., 2.4))
                    .child(
                        div()
                            .id(("annotator-card-delete", index))
                            .debug_selector(move || format!("annotator-card-delete-{index}"))
                            .size(px(16.))
                            .rounded_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .bg(rgba(GRIP_BUTTON))
                            .cursor_pointer()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if index < this.cards.len() {
                                    this.cards.remove(index);
                                    this.focus.focus(window);
                                    cx.notify();
                                }
                            }))
                            .child(crate::icon::stroke(
                                CLOSE,
                                crate::theme::on_accent(),
                                9.,
                                3.,
                            )),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .left(px((m.pad * scale - border).max(0.)))
                    .top(px(((m.pad - lead) * scale - border).max(0.)))
                    // The input wraps at its own width: give it the rest of
                    // the box, so the measured line never breaks early.
                    .w(px((w * scale - border - m.pad * scale).max(1.)))
                    .text_color(rgb(CARD_INK))
                    .font_family(SharedString::from(super::annotate_raster::card_family()))
                    .text_size(px(m.font * scale))
                    .line_height(px(m.line_h * scale))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .whitespace_nowrap()
                    .child(card.input.clone()),
            )
            .into_any_element()
    }
}

fn paint_shape(shape: &Shape, origin: Point<Pixels>, scale: f32, window: &mut Window) {
    let at = |x: f32, y: f32| point(origin.x + px(x * scale), origin.y + px(y * scale));
    let color = |c: usize| rgb(PALETTE[c]);
    match shape {
        Shape::Box {
            x1,
            y1,
            x2,
            y2,
            color: c,
            width,
        } => {
            let mut path = PathBuilder::stroke(px((width * scale).max(1.)));
            path.move_to(at(*x1, *y1));
            path.line_to(at(*x2, *y1));
            path.line_to(at(*x2, *y2));
            path.line_to(at(*x1, *y2));
            path.close();
            if let Ok(path) = path.build() {
                window.paint_path(path, color(*c));
            }
        }
        Shape::Highlight {
            x1,
            y1,
            x2,
            y2,
            color: c,
        } => {
            let mut fill = color(*c);
            fill.a = 0.3;
            let bounds =
                Bounds::from_corners(at(x1.min(*x2), y1.min(*y2)), at(x1.max(*x2), y1.max(*y2)));
            window.paint_quad(gpui::fill(bounds, fill));
        }
        Shape::Arrow {
            x1,
            y1,
            x2,
            y2,
            color: c,
            width,
        } => {
            let mut line = PathBuilder::stroke(px((width * scale).max(1.)));
            line.move_to(at(*x1, *y1));
            line.line_to(at(*x2, *y2));
            if let Ok(line) = line.build() {
                window.paint_path(line, color(*c));
            }
            let [(ax, ay), (bx, by)] =
                super::annotate_raster::arrow_head(*x1, *y1, *x2, *y2, *width);
            let mut head = PathBuilder::fill();
            head.move_to(at(*x2, *y2));
            head.line_to(at(ax, ay));
            head.line_to(at(bx, by));
            head.close();
            if let Ok(head) = head.build() {
                window.paint_path(head, color(*c));
            }
        }
        Shape::Pen {
            points,
            color: c,
            width,
        } => {
            let mut path = PathBuilder::stroke(px((width * scale).max(1.)));
            for (i, (x, y)) in points.iter().enumerate() {
                if i == 0 {
                    path.move_to(at(*x, *y));
                } else {
                    path.line_to(at(*x, *y));
                }
            }
            if points.len() == 1 {
                path.line_to(at(points[0].0 + 0.5, points[0].1));
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, color(*c));
            }
        }
    }
}

impl Render for Annotator {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        // The desktop's fit: shrink to the window, never enlarge.
        let scale = (f32::from(viewport.width - px(48.)) / self.width)
            .min(f32::from(viewport.height - px(180.)) / self.height)
            .min(1.)
            .max(0.05);
        let (shown_w, shown_h) = (self.width * scale, self.height * scale);
        // Card text uses the bake's size at this scale.
        let metrics = super::annotate_raster::card_metrics(self.width);
        let type_size = Some((metrics.font * scale, metrics.line_h * scale));
        for card in &self.cards {
            if card.input.read(cx).type_size != type_size {
                card.input
                    .update(cx, |input, _| input.type_size = type_size);
            }
        }
        let shapes: Vec<Shape> = self
            .shapes
            .iter()
            .chain(self.draft.as_ref())
            .cloned()
            .collect();
        let stage = self.stage.clone();
        let hint = if self.tool == Tool::Text {
            "Click to add a note · Drag its handle to move it"
        } else {
            "Draw to mark the detail · ⌘Z undo · Esc cancel"
        };
        div()
            .id("annotator")
            .debug_selector(|| "composer-annotator".into())
            .key_context("Annotator")
            .track_focus(&self.focus)
            .w(viewport.width)
            .h(viewport.height)
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(16.))
            .p(px(16.))
            .bg(rgba(SCRIM))
            // Blocks hover and clicks for everything under the editor.
            .occlude()
            .font_family(theme().font_ui)
            .on_key_down(cx.listener(Self::key))
            .on_mouse_move(cx.listener(Self::moved))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::up))
            // A click on the scrim closes the editor, as on the desktop.
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| this.cancel(cx)),
            )
            .child(
                div()
                    .id("annotator-stage")
                    .debug_selector(|| "annotator-stage".into())
                    .relative()
                    .w(px(shown_w))
                    .h(px(shown_h))
                    .flex_shrink_0()
                    .rounded(px(12.))
                    .shadow_lg()
                    .cursor(if self.tool == Tool::Text {
                        gpui::CursorStyle::IBeam
                    } else {
                        gpui::CursorStyle::Crosshair
                    })
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::down))
                    .child(img(self.preview.clone()).size_full().rounded(px(12.)))
                    .child(
                        canvas(
                            move |bounds, _, _| stage.set(bounds),
                            move |bounds, _, window, _| {
                                for shape in &shapes {
                                    paint_shape(shape, bounds.origin, scale, window);
                                }
                            },
                        )
                        .absolute()
                        .inset_0(),
                    )
                    .children((0..self.cards.len()).map(|i| self.card(i, scale, cx))),
            )
            .child(self.toolbar(cx))
            .when_some(self.error.clone(), |v, error| {
                v.child(
                    div()
                        .debug_selector(|| "annotator-error".into())
                        .text_color(theme().danger)
                        .child(error),
                )
            })
            .child(div().text_size(px(11.)).text_color(rgba(HINT)).child(hint))
    }
}

/// Opens the annotator over the window for one attached image.
pub(crate) fn overlay(annotator: &Entity<Annotator>, _: &App) -> AnyElement {
    gpui::deferred(
        gpui::anchored()
            .position_mode(gpui::AnchoredPositionMode::Window)
            .position(point(px(0.), px(0.)))
            .child(annotator.clone()),
    )
    .with_priority(3)
    .into_any_element()
}
