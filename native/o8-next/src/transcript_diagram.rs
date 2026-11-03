//! Bounded native diagrams for closed transcript fences.
use crate::{text::Node, theme::current as theme};
use gpui::{
    AnyElement, App, AvailableSpace, BorderStyle, Bounds, ClipboardItem, FontWeight, PathBuilder,
    Pixels, Point, Rgba, ShapedLine, SharedString, TextRun, Window, div, fill, font, outline,
    point, prelude::*, px, quad, size,
};
use std::collections::BTreeSet;

mod layout;
mod parse;
use layout::layout;
use parse::parse;

#[derive(Clone, Copy, Debug, PartialEq)]
enum ParseError {
    Unsupported,
    Limit,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Shape {
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
}
#[derive(Clone, Debug)]
struct Vertex {
    id: String,
    label: String,
    shape: Shape,
}
#[derive(Clone, Debug)]
struct Edge {
    from: usize,
    to: usize,
    label: String,
    dashed: bool,
    arrow: bool,
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
}
#[derive(Clone, Copy, Debug)]
struct BoxRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}
struct Label {
    text: String,
    rect: BoxRect,
    background: bool,
}
struct Stroke {
    points: Vec<(f32, f32)>,
    dashed: bool,
    arrow: bool,
}
#[derive(Default)]
struct Scene {
    boxes: Vec<BoxRect>,
    shapes: Vec<Shape>,
    strokes: Vec<Stroke>,
    labels: Vec<Label>,
    width: f32,
    height: f32,
    scale: f32,
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
    height: f32,
}
pub(crate) struct Placement {
    pub bounds: Bounds<Pixels>,
    source: String,
    pub shown: bool,
    header: f32,
    scene: Scene,
    inset: f32,
    labels: Vec<PaintedLabel>,
}
impl Placement {
    pub(crate) fn new(
        node: &Node,
        index: usize,
        origin: Point<Pixels>,
        width: Pixels,
        shown_sources: &BTreeSet<usize>,
        window: &Window,
    ) -> Option<Self> {
        let (diagram, source) = for_node(node)?;
        let shown = shown_sources.contains(&index);
        let inset = 8f32.min(f32::from(width) / 4.);
        let scene = layout(&diagram, (f32::from(width) - inset * 2.).max(1.));
        let mut face = font(theme().font_ui);
        face.weight = FontWeight::LIGHT;
        let labels = scene
            .labels
            .iter()
            .map(|label| {
                let mut font_size = 12. * scene.scale;
                let run = TextRun {
                    len: label.text.len(),
                    font: face.clone(),
                    color: theme().text.into(),
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
                if measured > label.rect.w && measured > 0. {
                    font_size *= label.rect.w / measured;
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
                    height: font_size * 1.5,
                }
            })
            .collect();
        let header = if width < px(340.) { 64. } else { 40. };
        Some(Self {
            bounds: Bounds::new(origin, size(width, px(header + scene.height + 16.))),
            source,
            shown,
            header,
            inset,
            scene,
            labels,
        })
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
        let origin = bounds.origin + point(px(self.inset), px(self.header));
        let at = |(x, y)| origin + point(px(x), px(y));
        for stroke in &self.scene.strokes {
            let mut path = PathBuilder::stroke(px(1.));
            if stroke.dashed {
                path = path.dash_array(&[px(4.), px(4.)]);
            }
            for (index, &p) in stroke.points.iter().enumerate() {
                if index == 0 {
                    path.move_to(at(p));
                } else {
                    path.line_to(at(p));
                }
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, theme().text_muted);
            }
            if stroke.arrow
                && let Some((&end, rest)) = stroke.points.split_last()
                && let Some(&before) = rest.iter().rev().find(|&&p| p != end)
            {
                let angle = (end.1 - before.1).atan2(end.0 - before.0);
                let length = 6. * self.scene.scale.min(1.);
                let mut head = PathBuilder::stroke(px(1.));
                for sign in [-1., 1.] {
                    head.move_to(at((
                        end.0 - length * (angle + sign * 0.5).cos(),
                        end.1 - length * (angle + sign * 0.5).sin(),
                    )));
                    head.line_to(at(end));
                }
                if let Ok(path) = head.build() {
                    window.paint_path(path, theme().accent);
                }
            }
        }
        for (&rect, &shape) in self.scene.boxes.iter().zip(&self.scene.shapes) {
            paint_shape(rect, shape, origin, window);
        }
        for label in &self.labels {
            let r = label.bounds;
            let origin = origin
                + point(
                    px(r.x + (r.w - f32::from(label.line.width)) / 2.),
                    px(r.y + (r.h - label.height) / 2.),
                );
            if label.background {
                window.paint_quad(fill(
                    Bounds::new(
                        origin - point(px(2.), px(0.)),
                        size(label.line.width + px(4.), px(label.height)),
                    ),
                    theme().code_background,
                ));
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
    let points = match shape {
        Shape::Diamond => vec![
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
#[cfg(test)]
#[path = "transcript_diagram_tests.rs"]
mod tests;
