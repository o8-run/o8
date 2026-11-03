//! Bounded native diagrams for closed transcript fences.
use crate::{text::Node, theme::current as theme};
use gpui::{
    AnyElement, App, AvailableSpace, BorderStyle, Bounds, ClipboardItem, CursorStyle,
    DispatchPhase, FontWeight, Hitbox, HitboxBehavior, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, PathBuilder, Pixels, Point, Rgba, ScrollWheelEvent, ShapedLine, SharedString,
    TextRun, Window, div, fill, font, outline, point, prelude::*, px, quad, size,
};
use std::{cell::RefCell, collections::BTreeSet};

mod class;
mod layout;
mod parse;
mod pie;
mod state;
mod zoom;
use layout::layout;
#[cfg(test)]
use layout::{crosses, overlap};
use parse::parse;
pub(crate) use zoom::Views;
#[cfg(test)]
use zoom::{MAX_ZOOM, MIN_ZOOM};
use zoom::{Viewport, zooms};

#[derive(Clone, Copy, Debug, PartialEq)]
enum ParseError {
    Unsupported,
    Limit,
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Shape {
    #[default]
    Rect,
    Round,
    Stadium,
    Circle,
    DoubleCircle,
    Diamond,
    Hexagon,
    Cylinder,
    Subroutine,
    Slant,
    Note,
    Start,
    End,
    Choice,
    Bar,
    Class,
}
/// The UML end of a class relation.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Marker {
    #[default]
    None,
    Arrow,
    Triangle,
    Diamond,
    FilledDiamond,
    Circle,
}
#[derive(Clone, Debug, Default)]
struct Vertex {
    id: String,
    label: String,
    shape: Shape,
    /// Lines over the title, such as a class's annotations.
    above: Vec<String>,
    /// Compartments under the title, each after a rule.
    sections: Vec<Vec<String>>,
}
#[derive(Clone, Debug, Default)]
struct Edge {
    from: usize,
    to: usize,
    label: String,
    dashed: bool,
    arrow: bool,
    /// Markers at the source and target ends.
    marks: [Marker; 2],
    /// Labels at the source and target ends, such as cardinalities.
    ends: [String; 2],
}
#[derive(Clone, Debug)]
enum Event {
    Message(Edge),
    Note {
        from: usize,
        to: usize,
        side: i8,
        label: String,
    },
}
#[derive(Clone, Debug)]
enum Diagram {
    Flow {
        lr: bool,
        nodes: Vec<Vertex>,
        edges: Vec<Edge>,
    },
    Sequence {
        participants: Vec<Vertex>,
        events: Vec<Event>,
    },
    Pie {
        title: String,
        show_data: bool,
        slices: Vec<(String, f64)>,
    },
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct BoxRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}
#[derive(Default)]
struct Label {
    text: String,
    rect: BoxRect,
    background: bool,
    left: bool,
    /// Drawn on this series color rather than the card.
    on_fill: Option<usize>,
    /// The edge this labels, by index into the scene's strokes.
    edge: Option<usize>,
    /// An end label, such as a class multiplicity.
    multiplicity: bool,
}
struct Stroke {
    points: Vec<(f32, f32)>,
    dashed: bool,
    arrow: bool,
    marks: [Marker; 2],
    /// The label plate the line stops at, on either side.
    gap: Option<BoxRect>,
}
/// A pie slice, clockwise from twelve o'clock in radians.
#[derive(Clone, Copy, Debug)]
struct Wedge {
    cx: f32,
    cy: f32,
    r: f32,
    start: f32,
    end: f32,
    color: usize,
}
#[derive(Default)]
struct Scene {
    boxes: Vec<BoxRect>,
    shapes: Vec<Shape>,
    strokes: Vec<Stroke>,
    labels: Vec<Label>,
    rules: Vec<[(f32, f32); 2]>,
    wedges: Vec<Wedge>,
    swatches: Vec<(BoxRect, usize)>,
    width: f32,
    height: f32,
    scale: f32,
}
/// Series colors from the theme's semantic tokens.
fn series(index: usize) -> Rgba {
    let t = theme();
    [
        t.accent,
        t.syntax_link,
        t.success,
        t.warning,
        t.syntax_keyword,
        t.syntax_string,
        t.danger,
        t.syntax_emphasis,
    ][index % 8]
}
fn for_node(node: &Node) -> Option<(Diagram, String)> {
    if node.kind != "code-block"
        || !node.fence_closed
        || !node
            .language
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("mermaid"))
    {
        return None;
    }
    if node
        .runs
        .iter()
        .fold(0usize, |n, r| n.saturating_add(r.text.len()))
        > 65_536
    {
        return None;
    }
    let source: String = node.runs.iter().map(|r| r.text.as_str()).collect();
    parse(&source).ok().map(|diagram| (diagram, source))
}
struct PaintedLabel {
    line: ShapedLine,
    bounds: BoxRect,
    background: bool,
    left: bool,
    height: f32,
}
/// Shapes the scene's labels for a zoom, shrinking any that overflow their box.
fn shape_labels(scene: &Scene, zoom: f32, window: &Window) -> Vec<PaintedLabel> {
    let mut face = font(theme().font_ui);
    face.weight = FontWeight::LIGHT;
    scene
        .labels
        .iter()
        .map(|label| {
            let room = label.rect.w * zoom;
            // End labels are a step smaller than the edge they annotate.
            let base = if label.multiplicity { 11. } else { 12. };
            let mut font_size = base * scene.scale * zoom;
            let run = TextRun {
                len: label.text.len(),
                font: face.clone(),
                color: match label.on_fill {
                    Some(color) => ink(series(color), theme().text, theme().background).into(),
                    None => theme().text.into(),
                },
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let mut line = window.text_system().shape_line(
                label.text.clone().into(),
                px(font_size),
                &[run.clone()],
                None,
            );
            let measured = f32::from(line.width);
            if measured > room && measured > 0. {
                font_size *= room / measured;
                line = window.text_system().shape_line(
                    label.text.clone().into(),
                    px(font_size),
                    &[run],
                    None,
                );
            }
            PaintedLabel {
                line,
                bounds: label.rect,
                background: label.background,
                left: label.left,
                height: font_size * 1.5,
            }
        })
        .collect()
}
pub(crate) struct Placement {
    pub bounds: Bounds<Pixels>,
    source: String,
    pub shown: bool,
    header: f32,
    scene: Scene,
    inset: f32,
    index: usize,
    views: Views,
    /// Labels shaped at the zoom they were last painted at.
    labels: RefCell<(f32, Vec<PaintedLabel>)>,
}
impl Placement {
    pub(crate) fn new(
        node: &Node,
        index: usize,
        origin: Point<Pixels>,
        width: Pixels,
        shown_sources: &BTreeSet<usize>,
        views: &Views,
        window: &Window,
    ) -> Option<Self> {
        let (diagram, source) = for_node(node)?;
        let shown = shown_sources.contains(&index);
        let inset = 8f32.min(f32::from(width) / 4.);
        let scene = layout(&diagram, (f32::from(width) - inset * 2.).max(1.));
        let zoom = views.get(index).zoom;
        let labels = RefCell::new((zoom, shape_labels(&scene, zoom, window)));
        let header = if width < px(340.) { 64. } else { 40. };
        Some(Self {
            bounds: Bounds::new(origin, size(width, px(header + scene.height + 16.))),
            source,
            shown,
            header,
            inset,
            scene,
            index,
            views: views.clone(),
            labels,
        })
    }
    /// The drawing's area under the header, where zoom and pan apply.
    fn body(&self, origin: Point<Pixels>) -> Bounds<Pixels> {
        let bounds = Bounds::new(origin + self.bounds.origin, self.bounds.size);
        Bounds::new(
            bounds.origin + point(px(1.), px(self.header - 4.)),
            size(
                (bounds.size.width - px(2.)).max(px(0.)),
                (bounds.size.height - px(self.header - 3.)).max(px(0.)),
            ),
        )
    }
    pub(crate) fn hitbox(&self, origin: Point<Pixels>, window: &mut Window) -> Hitbox {
        window.insert_hitbox(self.body(origin), HitboxBehavior::Normal)
    }
    /// Ctrl or Cmd with the wheel zooms around the pointer, a drag pans and a
    /// double click resets. A plain wheel is left to the transcript.
    pub(crate) fn interact(&self, origin: Point<Pixels>, hitbox: &Hitbox, window: &mut Window) {
        window.set_cursor_style(
            if self.views.dragging(self.index) {
                CursorStyle::ClosedHand
            } else {
                CursorStyle::OpenHand
            },
            hitbox,
        );
        let drawing = self.body(origin).origin + point(px(self.inset - 1.), px(4.));
        let local =
            move |p: Point<Pixels>| (f32::from(p.x - drawing.x), f32::from(p.y - drawing.y));
        let index = self.index;
        let (views, hit) = (self.views.clone(), hitbox.clone());
        // The list scrolls in the bubble phase, so a zoom has to claim the wheel first.
        window.on_mouse_event(move |event: &ScrollWheelEvent, phase, window, cx| {
            if phase == DispatchPhase::Capture && zooms(&event.modifiers) && hit.is_hovered(window)
            {
                let delta = event.delta.pixel_delta(px(20.));
                views.update(index, |view| {
                    view.wheel(f32::from(delta.y), local(event.position))
                });
                cx.stop_propagation();
                window.refresh();
            }
        });
        let (views, hit) = (self.views.clone(), hitbox.clone());
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
            if phase == DispatchPhase::Bubble
                && event.button == MouseButton::Left
                && hit.is_hovered(window)
            {
                if event.click_count >= 2 {
                    views.update(index, Viewport::reset);
                    views.end_drag();
                } else {
                    views.start_drag(index, event.position);
                }
                cx.stop_propagation();
                window.refresh();
            }
        });
        let views = self.views.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, _| {
            if phase != DispatchPhase::Bubble || !views.dragging(index) {
                return;
            }
            if event.dragging() {
                views.drag_to(index, event.position);
            } else {
                views.end_drag();
            }
            window.refresh();
        });
        let views = self.views.clone();
        window.on_mouse_event(move |_: &MouseUpEvent, phase, _, _| {
            if phase == DispatchPhase::Bubble && views.dragging(index) {
                views.end_drag();
            }
        });
    }
    pub(crate) fn paint(&self, origin: Point<Pixels>, window: &mut Window, cx: &mut App) {
        let bounds = Bounds::new(origin + self.bounds.origin, self.bounds.size);
        window.paint_quad(quad(
            bounds,
            px(10.),
            theme().code_background,
            px(1.),
            theme().border,
            BorderStyle::Solid,
        ));
        let view = self.views.get(self.index);
        let mask = gpui::ContentMask {
            bounds: self.body(origin),
        };
        window.with_content_mask(Some(mask), |window| {
            self.paint_drawing(bounds.origin, view, window, cx)
        });
    }
    fn paint_drawing(
        &self,
        card: Point<Pixels>,
        view: zoom::Viewport,
        window: &mut Window,
        cx: &mut App,
    ) {
        let origin = card + point(px(self.inset), px(self.header));
        let zoom = view.zoom;
        let at = |p| {
            let (x, y) = view.apply(p);
            origin + point(px(x), px(y))
        };
        let place = |r: BoxRect| {
            let (x, y) = view.apply((r.x, r.y));
            BoxRect {
                x,
                y,
                w: r.w * zoom,
                h: r.h * zoom,
            }
        };
        for wedge in &self.scene.wedges {
            paint_wedge(wedge, &at, zoom, window);
        }
        for &(rect, color) in &self.scene.swatches {
            let r = place(rect);
            window.paint_quad(
                fill(
                    Bounds::new(origin + point(px(r.x), px(r.y)), size(px(r.w), px(r.h))),
                    series(color),
                )
                .corner_radii(px(2. * zoom)),
            );
        }
        let marker = 6. * self.scene.scale.min(1.) * zoom;
        for stroke in &self.scene.strokes {
            // Paths paint over quads in a layer, so a line stops short of its
            // label plate and of a hollow marker rather than being covered.
            let mut pieces = stroke.pieces();
            let mark_at = |side: usize| {
                if side == 1 && stroke.arrow {
                    Marker::Arrow
                } else {
                    stroke.marks[side]
                }
            };
            for side in [0, 1] {
                let inset = marker_length(mark_at(side)) * marker / zoom;
                let piece = if side == 0 {
                    pieces.first_mut()
                } else {
                    pieces.last_mut()
                };
                if let Some(piece) = piece
                    && inset > 0.
                    && piece.len() > 1
                {
                    let (end, next) = if side == 0 {
                        (0, 1)
                    } else {
                        (piece.len() - 1, piece.len() - 2)
                    };
                    let (a, b) = (piece[end], piece[next]);
                    let length = (b.0 - a.0).hypot(b.1 - a.1);
                    if length > inset {
                        let t = inset / length;
                        piece[end] = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
                    }
                }
            }
            for piece in &pieces {
                let mut path = PathBuilder::stroke(px(1.));
                if stroke.dashed {
                    path = path.dash_array(&[px(4.), px(4.)]);
                }
                for (index, &p) in piece.iter().enumerate() {
                    if index == 0 {
                        path.move_to(at(p));
                    } else {
                        path.line_to(at(p));
                    }
                }
                if let Ok(path) = path.build() {
                    window.paint_path(path, theme().text_muted);
                }
            }
            let ends = [
                stroke
                    .points
                    .split_first()
                    .and_then(|(&end, rest)| Some((end, *rest.iter().find(|&&p| p != end)?))),
                stroke
                    .points
                    .split_last()
                    .and_then(|(&end, rest)| Some((end, *rest.iter().rev().find(|&&p| p != end)?))),
            ];
            for (side, end) in ends.into_iter().enumerate() {
                let Some((end, before)) = end else {
                    continue;
                };
                let mark = mark_at(side);
                let angle = (end.1 - before.1).atan2(end.0 - before.0);
                paint_marker(mark, at(end), angle, marker, window);
            }
        }
        for (&rect, &shape) in self.scene.boxes.iter().zip(&self.scene.shapes) {
            paint_shape(place(rect), shape, origin, window);
        }
        for &[a, b] in &self.scene.rules {
            let mut path = PathBuilder::stroke(px(1.));
            path.move_to(at(a));
            path.line_to(at(b));
            if let Ok(path) = path.build() {
                window.paint_path(path, theme().border);
            }
        }
        let mut labels = self.labels.borrow_mut();
        if labels.0 != zoom {
            *labels = (zoom, shape_labels(&self.scene, zoom, window));
        }
        for label in &labels.1 {
            let r = place(label.bounds);
            let x = if label.left {
                r.x
            } else {
                r.x + (r.w - f32::from(label.line.width)) / 2.
            };
            let origin = origin + point(px(x), px(r.y + (r.h - label.height) / 2.));
            if label.background {
                window.paint_quad(
                    fill(
                        Bounds::new(
                            origin - point(px(4.), px(0.)),
                            size(label.line.width + px(8.), px(label.height)),
                        ),
                        theme().code_background,
                    )
                    .corner_radii(px(label.height / 2.)),
                );
            }
            let _ = label.line.paint(origin, px(label.height), window, cx);
        }
    }
    pub(crate) fn controls(
        &self,
        row: usize,
        index: usize,
        origin: Point<Pixels>,
        toggle: impl Fn(&mut Window, &mut App) + Clone + 'static,
        window: &mut Window,
        cx: &mut App,
    ) -> Vec<AnyElement> {
        let bounds = Bounds::new(origin + self.bounds.origin, self.bounds.size);
        let compact = self.header > 40.;
        let y = if compact { 32. } else { 8. };
        let padding = px(12.).min(bounds.size.width / 4.);
        let inner = (bounds.size.width - padding * 2.).max(px(1.));
        let gap = px(8.).min(inner / 10.);
        let copy_width = ((inner - gap) * 0.45).min(px(88.));
        let source_width = (inner - gap - copy_width).min(px(100.));
        let x = if compact {
            padding
        } else {
            (bounds.size.width - px(208.)).max(px(12.))
        };
        let copy = self.source.clone();
        let buttons = [
            (
                button(
                    format!("mermaid-{row}-{index}-copy"),
                    "Copy source",
                    move |_, cx| cx.write_to_clipboard(ClipboardItem::new_string(copy.clone())),
                ),
                point(x, px(y)),
                copy_width,
            ),
            (
                button(
                    format!("mermaid-{row}-{index}-source"),
                    if self.shown {
                        "Hide source"
                    } else {
                        "Show source"
                    },
                    toggle,
                ),
                point(x + copy_width + gap, px(y)),
                source_width,
            ),
        ];
        let title = div()
            .font_family(theme().font_ui)
            .font_weight(FontWeight::LIGHT)
            .text_size(px(10.))
            .text_color(theme().text_muted)
            .child("MERMAID")
            .into_any_element();
        let mut elements = vec![(title, point(padding, px(10.)), px(64.).min(inner))];
        elements.extend(buttons);
        elements
            .into_iter()
            .map(|(mut element, offset, width)| {
                element.layout_as_root(
                    size(
                        AvailableSpace::Definite(width),
                        AvailableSpace::Definite(px(24.)),
                    ),
                    window,
                    cx,
                );
                element.prepaint_at(bounds.origin + offset, window, cx);
                element
            })
            .collect()
    }
}
fn button(
    selector: String,
    label: &'static str,
    action: impl Fn(&mut Window, &mut App) + Clone + 'static,
) -> AnyElement {
    let key = action.clone();
    div()
        .id(SharedString::from(selector.clone()))
        .debug_selector(move || selector.clone())
        .focusable()
        .cursor_pointer()
        .overflow_hidden()
        .w_full()
        .h(px(24.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .border_1()
        .border_color(theme().border)
        .font_family(theme().font_ui)
        .font_weight(FontWeight::LIGHT)
        .text_size(px(11.))
        .text_color(theme().text_secondary)
        .hover(|s| s.bg(theme().hover))
        .focus(|s| s.border_color(theme().accent))
        .child(label)
        .on_click(move |_, window, cx| {
            action(window, cx);
            cx.stop_propagation();
        })
        .on_key_down(move |event, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space")
                && !event.keystroke.modifiers.modified()
            {
                key(window, cx);
                cx.stop_propagation();
            }
        })
        .into_any_element()
}
fn polygon(
    points: &[(f32, f32)],
    origin: Point<Pixels>,
    fill_color: Option<Rgba>,
    window: &mut Window,
) {
    for filled in [true, false] {
        if filled && fill_color.is_none() {
            continue;
        }
        let mut path = if filled {
            PathBuilder::fill()
        } else {
            PathBuilder::stroke(px(1.))
        };
        for (index, &(x, y)) in points.iter().enumerate() {
            let p = origin + point(px(x), px(y));
            if index == 0 {
                path.move_to(p);
            } else {
                path.line_to(p);
            }
        }
        path.close();
        if let Ok(path) = path.build() {
            window.paint_path(
                path,
                if filled {
                    fill_color.unwrap_or(theme().surface)
                } else {
                    theme().border
                },
            );
        }
    }
}
fn paint_shape(rect: BoxRect, shape: Shape, origin: Point<Pixels>, window: &mut Window) {
    let BoxRect { x, y, w, h } = rect;
    let bounds = Bounds::new(origin + point(px(x), px(y)), size(px(w), px(h)));
    match shape {
        Shape::Start => {
            window.paint_quad(fill(bounds, theme().text).corner_radii(px(w.min(h) / 2.)));
            return;
        }
        Shape::End => {
            window.paint_quad(quad(
                bounds,
                px(w.min(h) / 2.),
                theme().code_background,
                px(1.),
                theme().text,
                BorderStyle::Solid,
            ));
            let inner = bounds.inset(px(w.min(h) * 0.22));
            window.paint_quad(fill(inner, theme().text).corner_radii(px(w.min(h) * 0.28)));
            return;
        }
        Shape::Bar => {
            window.paint_quad(
                fill(bounds, theme().text_muted).corner_radii(px(2f32.min(w.min(h) / 2.))),
            );
            return;
        }
        _ => {}
    }
    let points = match shape {
        Shape::Diamond | Shape::Choice => vec![
            (x + w / 2., y),
            (x + w, y + h / 2.),
            (x + w / 2., y + h),
            (x, y + h / 2.),
        ],
        Shape::Hexagon => vec![
            (x + w * 0.15, y),
            (x + w * 0.85, y),
            (x + w, y + h / 2.),
            (x + w * 0.85, y + h),
            (x + w * 0.15, y + h),
            (x, y + h / 2.),
        ],
        Shape::Slant => vec![
            (x + w * 0.15, y),
            (x + w, y),
            (x + w * 0.85, y + h),
            (x, y + h),
        ],
        Shape::Note => vec![
            (x, y),
            (x + w - w.min(h).min(50.) / 5., y),
            (x + w, y + w.min(h).min(50.) / 5.),
            (x + w, y + h),
            (x, y + h),
        ],
        Shape::Cylinder => {
            let lip = (h * 0.12).min(6.);
            let ellipse = |cy: f32, start: usize, end: usize| {
                (start..=end)
                    .map(|i| {
                        let angle = i as f32 * std::f32::consts::PI / 16.;
                        (x + w / 2. + w / 2. * angle.cos(), cy + lip * angle.sin())
                    })
                    .collect::<Vec<_>>()
            };
            let mut points = ellipse(y + lip, 16, 32);
            points.extend(ellipse(y + h - lip, 0, 16));
            polygon(&points, origin, Some(theme().surface), window);
            polygon(&ellipse(y + lip, 0, 32), origin, None, window);
            return;
        }
        _ => vec![],
    };
    if !points.is_empty() {
        polygon(&points, origin, Some(theme().surface), window);
        return;
    }
    let radius = match shape {
        Shape::Round => 8f32.min(w.min(h) / 2.),
        Shape::Stadium | Shape::Circle | Shape::DoubleCircle => w.min(h) / 2.,
        _ => 2f32.min(w.min(h) / 2.),
    };
    window.paint_quad(quad(
        bounds,
        px(radius),
        theme().surface,
        px(1.),
        theme().border,
        BorderStyle::Solid,
    ));
    if shape == Shape::DoubleCircle {
        window.paint_quad(
            outline(
                bounds.inset(px(w.min(h).min(32.) / 8.)),
                theme().border,
                BorderStyle::Solid,
            )
            .corner_radii(px((radius - 4.).max(0.))),
        );
    }
    if shape == Shape::Subroutine {
        for line_x in [x + (w * 0.08).min(6.), x + w - (w * 0.08).min(6.)] {
            window.paint_quad(fill(
                Bounds::new(origin + point(px(line_x), px(y)), size(px(1.), px(h))),
                theme().border,
            ));
        }
    }
}
fn luminance(c: Rgba) -> f32 {
    let channel = |v: f32| {
        if v <= 0.040_45 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}
/// The WCAG contrast ratio of two opaque colors.
fn contrast(a: Rgba, b: Rgba) -> f32 {
    let (a, b) = (luminance(a), luminance(b));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}
/// Text for a series fill: whichever of the theme's text and background
/// inks, made opaque, contrasts more with it.
fn ink(fill: Rgba, light: Rgba, dark: Rgba) -> Rgba {
    let fill = Rgba { a: 1., ..fill };
    let (light, dark) = (Rgba { a: 1., ..light }, Rgba { a: 1., ..dark });
    if contrast(light, fill) >= contrast(dark, fill) {
        light
    } else {
        dark
    }
}
/// How far a marker reaches back along its line, in marker lengths.
fn marker_length(mark: Marker) -> f32 {
    match mark {
        Marker::None | Marker::Arrow => 0.,
        Marker::Triangle | Marker::Circle => 2.,
        Marker::Diamond | Marker::FilledDiamond => 2.4,
    }
}
/// A relation end at `tip`, pointing along `angle`.
fn paint_marker(mark: Marker, tip: Point<Pixels>, angle: f32, length: f32, window: &mut Window) {
    let (cos, sin) = (angle.cos(), angle.sin());
    // Along the edge toward the tip, then across it.
    let at = |along: f32, across: f32| {
        tip + point(
            px(-along * cos - across * sin),
            px(-along * sin + across * cos),
        )
    };
    let outline = match mark {
        Marker::None => return,
        Marker::Arrow => {
            let mut head = PathBuilder::stroke(px(1.));
            for sign in [-1., 1.] {
                head.move_to(
                    tip + point(
                        px(-length * (angle + sign * 0.5).cos()),
                        px(-length * (angle + sign * 0.5).sin()),
                    ),
                );
                head.line_to(tip);
            }
            if let Ok(path) = head.build() {
                window.paint_path(path, theme().accent);
            }
            return;
        }
        Marker::Triangle => vec![
            at(0., 0.),
            at(length * 2., length),
            at(length * 2., -length),
        ],
        Marker::Diamond | Marker::FilledDiamond => vec![
            at(0., 0.),
            at(length * 1.2, length * 0.8),
            at(length * 2.4, 0.),
            at(length * 1.2, -length * 0.8),
        ],
        Marker::Circle => (0..16)
            .map(|i| {
                let turn = i as f32 * std::f32::consts::TAU / 16.;
                at(length * (1. + turn.cos()), length * turn.sin())
            })
            .collect(),
    };
    let color = if mark == Marker::FilledDiamond {
        theme().text_muted
    } else {
        theme().code_background
    };
    for filled in [true, false] {
        let mut path = if filled {
            PathBuilder::fill()
        } else {
            PathBuilder::stroke(px(1.))
        };
        for (index, &p) in outline.iter().enumerate() {
            if index == 0 {
                path.move_to(p);
            } else {
                path.line_to(p);
            }
        }
        path.close();
        if let Ok(path) = path.build() {
            window.paint_path(path, if filled { color } else { theme().text_muted });
        }
    }
}
fn paint_wedge(
    wedge: &Wedge,
    at: &impl Fn((f32, f32)) -> Point<Pixels>,
    zoom: f32,
    window: &mut Window,
) {
    let steps = (((wedge.end - wedge.start) * wedge.r * zoom / 4.).ceil() as usize).clamp(2, 256);
    let rim = |angle: f32| {
        at((
            wedge.cx + wedge.r * angle.sin(),
            wedge.cy - wedge.r * angle.cos(),
        ))
    };
    let whole = wedge.end - wedge.start >= std::f32::consts::TAU - 1e-4;
    for filled in [true, false] {
        let mut path = if filled {
            PathBuilder::fill()
        } else {
            PathBuilder::stroke(px(1.))
        };
        if whole {
            path.move_to(rim(wedge.start));
        } else {
            path.move_to(at((wedge.cx, wedge.cy)));
            path.line_to(rim(wedge.start));
        }
        for step in 1..=steps {
            path.line_to(rim(
                wedge.start + (wedge.end - wedge.start) * step as f32 / steps as f32
            ));
        }
        path.close();
        if let Ok(path) = path.build() {
            window.paint_path(
                path,
                if filled {
                    series(wedge.color)
                } else {
                    theme().code_background
                },
            );
        }
    }
}
#[cfg(test)]
#[path = "transcript_diagram_tests.rs"]
mod tests;
