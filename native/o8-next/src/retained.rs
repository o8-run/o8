//! Retained transcript text layout. Only content or viewport-width changes reshape
//! a row. Moving/repainting an unchanged row reuses its shaped lines and height.
use crate::theme::current as theme;
use crate::{
    model::Row,
    text::{Node, Run},
};
use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, Point, Size, Style, TextAlign, TextRun, Window, WrappedLine,
    font, point, px, size,
};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

pub struct RowState {
    pub row: Row,
    pub layouts: usize,
    expanded: Option<bool>,
    cache: Option<Layout>,
    pub cards: crate::visualizations::Cards,
}
impl RowState {
    #[cfg(test)]
    pub fn rendered(&self) -> (Pixels, Vec<String>) {
        let cache = self.cache.as_ref().expect("row reached layout");
        (
            cache.size.height,
            cache
                .lines
                .iter()
                .map(|line| line.line.text.to_string())
                .collect(),
        )
    }
    pub fn new(row: Row) -> Self {
        let expanded = matches!(&row, Row::Message { nodes, .. } if nodes.iter().any(crate::rich::system_event))
            .then_some(false);
        Self {
            row,
            layouts: 0,
            expanded,
            cache: None,
            cards: Default::default(),
        }
    }
    pub fn attach_visualizations(&mut self, client: &crate::client::Client) {
        let mut keep = std::collections::HashSet::new();
        if let Row::Message { nodes, .. } = &self.row {
            for node in nodes.iter().filter(|n| n.kind == "visualization") {
                if let Some(reference) = node
                    .data
                    .as_ref()
                    .and_then(crate::visualizations::protocol::Reference::parse)
                {
                    keep.insert(reference.id.clone());
                    self.cards.entry(reference.id.clone()).or_insert_with(|| {
                        Rc::new(RefCell::new(crate::visualizations::Card::new(
                            reference,
                            client.clone(),
                        )))
                    });
                }
            }
        }
        self.cards.retain(|id, _| keep.contains(id));
    }
    pub fn poll_visualizations(&mut self) -> bool {
        let mut changed = false;
        for card in self.cards.values() {
            changed |= card.borrow_mut().poll();
        }
        if changed {
            self.cache = None;
        }
        changed
    }
}
struct Line {
    line: WrappedLine,
    origin: Point<Pixels>,
    height: Pixels,
    align: TextAlign,
}
struct Backdrop {
    bounds: Bounds<Pixels>,
    color: gpui::Rgba,
}
struct Layout {
    size: Size<Pixels>,
    lines: Vec<Line>,
    backgrounds: Vec<Backdrop>,
    cards: Vec<(String, Bounds<Pixels>)>,
}
struct Builder {
    width: Pixels,
    y: Pixels,
    lines: Vec<Line>,
    backgrounds: Vec<Backdrop>,
}
impl Builder {
    fn rich_node(&mut self, kind: &str, data: &serde_json::Value, expanded: bool, window: &Window) {
        let label = |value: &serde_json::Value| value.as_str().unwrap_or("").to_owned();
        if kind == "table" {
            let headers = data["headers"].as_array().cloned().unwrap_or_default();
            let width = (self.width - px(48.)) / headers.len().max(1) as f32;
            let mut rows = vec![headers];
            rows.extend(
                data["rows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|row| row.as_array().cloned()),
            );
            for (row_index, cells) in rows.iter().enumerate() {
                let top = self.y;
                let mut bottom = top;
                for (column, cell) in cells.iter().enumerate() {
                    let mut builder = Builder {
                        width: width + px(48.),
                        y: top,
                        lines: vec![],
                        backgrounds: vec![],
                    };
                    let mut runs: Vec<Run> =
                        serde_json::from_value(cell.clone()).unwrap_or_default();
                    if row_index == 0 {
                        for run in &mut runs {
                            run.style = "strong".into();
                        }
                    }
                    builder.text(&runs, 13., 19.5, 0., window);
                    for mut line in builder.lines {
                        line.origin.x += width * column as f32;
                        line.align = match data["aligns"][column].as_str() {
                            Some("right") => TextAlign::Right,
                            Some("center") => TextAlign::Center,
                            _ => TextAlign::Left,
                        };
                        self.lines.push(line);
                    }
                    bottom = bottom.max(builder.y);
                }
                self.y = bottom + px(8.);
                self.backgrounds.push(Backdrop {
                    bounds: Bounds::new(point(px(24.), self.y), size(self.width - px(48.), px(1.))),
                    color: theme().border,
                });
                self.y += px(4.);
            }
            return;
        }
        if matches!(kind, "handoff" | "compaction") {
            let summary = crate::rich::event_summary(kind, data);
            let summary = crate::text::sanitize(&summary)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let text = format!("{} {summary}", if expanded { "⌄" } else { "›" });
            let mut runs = vec![text_run(&Run {
                style: "text".into(),
                text: text.clone(),
            })];
            let text = window
                .text_system()
                .line_wrapper(runs[0].font.clone(), px(12.))
                .truncate_line(
                    text.into(),
                    (self.width - px(48.)).max(px(1.)),
                    "…",
                    &mut runs,
                );
            for line in window
                .text_system()
                .shape_text(text, px(12.), &runs, None, None)
                .expect("event summary")
            {
                self.lines.push(Line {
                    line,
                    origin: point(px(24.), self.y),
                    height: px(18.),
                    align: TextAlign::Left,
                });
                self.y += px(18.);
            }
            if expanded {
                self.y += px(8.);
                for field in crate::rich::event_fields(data) {
                    self.plain(crate::text::sanitize(&field), 12., 18., window);
                }
            }
            return;
        }
        let lines = match kind {
            "media" => vec![
                format!(
                    "[{} placeholder] {}",
                    label(&data["kind"]),
                    label(&data["name"])
                ),
                format!("{} · {}", label(&data["mimeType"]), label(&data["path"])),
            ],
            _ => vec![],
        };
        let top = self.y;
        self.y += px(8.);
        for line in lines.into_iter().filter(|line| !line.is_empty()) {
            self.plain(crate::text::sanitize(&line), 12., 18., window);
        }
        self.y += px(8.);
        self.backgrounds.push(Backdrop {
            bounds: Bounds::new(
                point(px(24.), top),
                size(self.width - px(48.), self.y - top),
            ),
            color: theme().surface,
        });
    }
    fn text(
        &mut self,
        runs: &[Run],
        font_size: f32,
        line_height: f32,
        inset: f32,
        window: &Window,
    ) {
        let text: String = runs.iter().map(|r| r.text.as_str()).collect();
        let styled: Vec<TextRun> = runs.iter().map(text_run).collect();
        let width = (self.width - px(48. + inset * 2.)).max(px(1.));
        let lines = window
            .text_system()
            .shape_text(text.into(), px(font_size), &styled, Some(width), None)
            .expect("valid text runs");
        if lines.is_empty() {
            self.y += px(line_height);
        }
        for line in lines {
            let height = line.size(px(line_height)).height;
            self.lines.push(Line {
                line,
                origin: point(px(24. + inset), self.y),
                height: px(line_height),
                align: TextAlign::Left,
            });
            self.y += height;
        }
    }
    fn plain(&mut self, text: String, font_size: f32, line_height: f32, window: &Window) {
        self.text(
            &[Run {
                style: "text".into(),
                text,
            }],
            font_size,
            line_height,
            0.,
            window,
        );
    }
    fn node(&mut self, node: &Node, expanded: bool, window: &Window) {
        if let Some(data) = &node.data {
            self.rich_node(&node.kind, data, expanded, window);
            return;
        }
        if node.kind == "break" {
            self.y += px(6.);
            return;
        }
        if node.kind == "rule" {
            self.y += px(12.);
            self.backgrounds.push(Backdrop {
                bounds: Bounds::new(point(px(24.), self.y), size(self.width - px(48.), px(1.))),
                color: theme().border,
            });
            self.y += px(13.);
            return;
        }
        let code = node.kind == "code-block" || node.kind == "diff-card";
        let top = self.y;
        if code {
            self.y += px(18.);
            self.text(
                &[Run {
                    style: "text".into(),
                    text: node.language.clone().unwrap_or_default(),
                }],
                10.,
                15.,
                10.,
                window,
            );
        }
        if node.kind.starts_with('h') {
            self.y += px(8.);
        }
        let prefix = if node.kind == "ul" {
            "• ".into()
        } else if let Some(n) = node.kind.strip_prefix("ol:") {
            format!("{n} ")
        } else if node.kind == "quote" {
            "│ ".into()
        } else {
            String::new()
        };
        let mut runs = vec![];
        if !prefix.is_empty() {
            runs.push(Run {
                style: "text".into(),
                text: prefix,
            });
        }
        runs.extend(node.runs.clone());
        if node.kind == "diff-card" {
            for line in node.runs.iter().flat_map(|run| run.text.split('\n')) {
                self.text(
                    &[Run {
                        text: line.into(),
                        style: if line.starts_with('+') {
                            "diff-add"
                        } else if line.starts_with('-') {
                            "diff-remove"
                        } else {
                            "code"
                        }
                        .into(),
                    }],
                    12.,
                    19.5,
                    10.,
                    window,
                );
            }
        } else {
            self.text(
                &runs,
                if code { 12. } else { 13. },
                19.5,
                if code { 10. } else { 0. },
                window,
            );
        }
        if node.kind.starts_with('h') {
            self.y += px(4.);
        }
        if code {
            self.y += px(18.);
            self.backgrounds.push(Backdrop {
                bounds: Bounds::new(
                    point(px(24.), top + px(8.)),
                    size(self.width - px(48.), self.y - top - px(16.)),
                ),
                color: theme().code_background,
            });
        }
    }
}
fn layout(
    row: &Row,
    width: Pixels,
    expanded: bool,
    cards: &crate::visualizations::Cards,
    window: &Window,
) -> Layout {
    let mut b = Builder {
        width,
        y: px(8.),
        lines: vec![],
        backgrounds: vec![],
    };
    let mut placements = vec![];
    match row {
        Row::PacketHeader {
            prompt, details, ..
        } => {
            b.plain(
                crate::text::sanitize(
                    details
                        .as_ref()
                        .and_then(|d| d["title"].as_str())
                        .unwrap_or("Dispatched packet"),
                ),
                11.,
                16.,
                window,
            );
            if let Some(details) = details {
                for field in ["branch", "runtime", "status", "repo"] {
                    if let Some(value) = details[field].as_str() {
                        b.plain(
                            crate::text::sanitize(&format!("{field}: {value}")),
                            10.,
                            15.,
                            window,
                        );
                    }
                }
                if !details["launchContext"].is_null() {
                    b.plain(
                        crate::text::sanitize(&details["launchContext"].to_string()),
                        10.,
                        15.,
                        window,
                    );
                }
            }
            for node in crate::text::markdown(prompt) {
                b.node(&node, expanded, window);
            }
        }
        Row::Message { role, nodes, .. } => {
            let top = b.y;
            for node in nodes {
                let card = node
                    .data
                    .as_ref()
                    .and_then(|data| data["id"].as_str())
                    .and_then(|id| cards.get(id))
                    .filter(|_| node.kind == "visualization");
                if let Some(card) = card {
                    let card = card.borrow();
                    let top = b.y;
                    if let Some(error) = &card.error {
                        b.y += px(16.);
                        #[cfg(not(target_os = "macos"))]
                        {
                            b.plain(
                                crate::text::sanitize(&card.reference.title),
                                13.,
                                20.,
                                window,
                            );
                            b.y += px(8.);
                        }
                        b.plain(crate::text::sanitize(error), 13., 20., window);
                        b.y += px(10.);
                        b.plain(
                            crate::visualizations::protocol::RETRY.into(),
                            12.,
                            20.,
                            window,
                        );
                        b.y += px(16.);
                    } else if !card.ready {
                        b.plain("Loading visualization…".into(), 12., 20., window);
                    }
                    b.y = (top + px(card.display_height())).max(b.y);
                    placements.push((
                        card.reference.id.clone(),
                        Bounds::new(
                            point(px(24.), top),
                            size((width - px(48.)).max(px(1.)), b.y - top),
                        ),
                    ));
                } else {
                    b.node(node, expanded, window);
                }
            }
            if role == "user" {
                b.backgrounds.insert(
                    0,
                    Backdrop {
                        bounds: Bounds::new(
                            point(px(16.), top),
                            size((width - px(32.)).max(px(1.)), b.y - top + px(4.)),
                        ),
                        color: theme().selection,
                    },
                );
            }
            b.y += px(8.);
        }
        Row::Activity { steps, .. } => {
            b.y += px(8.);
            let mut previous = None;
            for step in steps {
                if previous != Some(step.group) {
                    b.y += px(4.);
                    previous = Some(step.group);
                }
                b.text(
                    &[Run {
                        style: "code".into(),
                        text: format!("{} · {}", step.status, crate::text::sanitize(&step.command)),
                    }],
                    11.,
                    16.,
                    0.,
                    window,
                );
                if let Some(reason) = &step.reason {
                    b.plain(crate::text::sanitize(reason), 11., 16., window);
                }
            }
        }
    }
    Layout {
        size: size(width, b.y + px(8.)),
        lines: b.lines,
        backgrounds: b.backgrounds,
        cards: placements,
    }
}
pub struct RetainedRow {
    pub state: Rc<RefCell<RowState>>,
    pub index: usize,
    pub painted: Rc<RefCell<BTreeSet<usize>>>,
}
impl RetainedRow {
    pub fn interactive(self, list: &gpui::ListState) -> gpui::AnyElement {
        use gpui::prelude::*;
        if !self.state.borrow().cards.is_empty() {
            let state = self.state.clone();
            let list = list.clone();
            let index = self.index;
            let retry = move |position: Option<Point<Pixels>>, window: &mut Window| {
                let mut state = state.borrow_mut();
                let card = state
                    .cards
                    .values()
                    .find(|card| {
                        let card = card.borrow();
                        card.error.is_some()
                            && position.is_none_or(|p| card.bounds.is_some_and(|b| b.contains(&p)))
                    })
                    .cloned();
                if let Some(card) = card {
                    card.borrow_mut().retry();
                    state.cache = None;
                    list.splice(index..index + 1, 1);
                    window.refresh();
                }
            };
            let click = retry.clone();
            return gpui::div()
                .id(("visualization-message", self.index))
                .focusable()
                .debug_selector(move || format!("visualization-message-{index}").into())
                .on_click(move |event, window, _| click(Some(event.position()), window))
                .on_key_down(move |event, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space")
                        && !event.keystroke.modifiers.modified()
                    {
                        retry(None, window);
                        cx.stop_propagation();
                    }
                })
                .child(self)
                .into_any_element();
        }
        if self.state.borrow().expanded.is_none() {
            return self.into_any_element();
        }
        let state = self.state.clone();
        let list = list.clone();
        let index = self.index;
        let toggle = move |window: &mut Window| {
            let mut state = state.borrow_mut();
            let expanded = state.expanded.as_mut().expect("system event");
            *expanded = !*expanded;
            state.cache = None;
            list.splice(index..index + 1, 1);
            window.refresh();
        };
        let click = toggle.clone();
        gpui::div()
            .id(("system-event", index))
            .focusable()
            .cursor_pointer()
            .focus(|style| style.bg(theme().hover))
            .on_click(move |_, window, cx| {
                click(window);
                cx.stop_propagation();
            })
            .on_key_down(move |event, window, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space")
                    && !event.keystroke.modifiers.modified()
                {
                    toggle(window);
                    cx.stop_propagation();
                }
            })
            .child(self)
            .into_any_element()
    }
}
impl IntoElement for RetainedRow {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for RetainedRow {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        (!self.state.borrow().cards.is_empty()).then(|| {
            ElementId::Name(format!("visualization-row:{}", self.state.borrow().row.id()).into())
        })
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        _: &mut App,
    ) -> (LayoutId, ()) {
        let state = self.state.clone();
        let mut style = Style::default();
        style.size.width = gpui::relative(1.).into();
        let id = window.request_measured_layout(style, move |known, available, window, _| {
            let width = known.width.unwrap_or(match available.width {
                AvailableSpace::Definite(w) => w,
                _ => px(1000.),
            });
            let mut state = state.borrow_mut();
            if state
                .cache
                .as_ref()
                .is_none_or(|cache| cache.size.width != width)
            {
                state.cache = Some(layout(
                    &state.row,
                    width,
                    state.expanded.unwrap_or(false),
                    &state.cards,
                    window,
                ));
                state.layouts += 1;
            }
            state.cache.as_ref().unwrap().size
        });
        (id, ())
    }
    fn prepaint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        _: &mut App,
    ) {
        if let Some(global_id) = global_id {
            let cards: Vec<_> = self.state.borrow().cards.values().cloned().collect();
            window.with_element_state::<crate::visualizations::Lease, _>(global_id, |lease, _| {
                let lease = lease.filter(|lease| {
                    lease.0.len() == cards.len()
                        && lease.0.iter().zip(&cards).all(|(a, b)| Rc::ptr_eq(a, b))
                });
                (
                    (),
                    lease.unwrap_or_else(|| crate::visualizations::Lease::new(cards)),
                )
            });
        }
        let state = self.state.borrow();
        if let Some(cache) = &state.cache {
            for (id, placement) in &cache.cards {
                if let Some(card) = state.cards.get(id) {
                    card.borrow_mut().paint(
                        Bounds::new(bounds.origin + placement.origin, placement.size),
                        window.content_mask().bounds,
                        window,
                    );
                }
            }
        }
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let state = self.state.borrow();
        let cache = state.cache.as_ref().expect("measured row");
        for background in &cache.backgrounds {
            window.paint_quad(gpui::fill(
                Bounds::new(
                    bounds.origin + background.bounds.origin,
                    background.bounds.size,
                ),
                background.color,
            ));
        }
        for line in &cache.lines {
            line.line
                .paint_background(
                    bounds.origin + line.origin,
                    line.height,
                    line.align,
                    None,
                    window,
                    cx,
                )
                .unwrap();
            line.line
                .paint(
                    bounds.origin + line.origin,
                    line.height,
                    line.align,
                    None,
                    window,
                    cx,
                )
                .unwrap();
        }
        self.painted.borrow_mut().insert(self.index);
    }
}

fn text_run(run: &Run) -> TextRun {
    let mut face = font(if run.style == "code" || run.style.starts_with("diff-") {
        theme().font_mono
    } else {
        theme().font_ui
    });
    face.weight = if run.style == "strong" {
        gpui::FontWeight::MEDIUM
    } else {
        gpui::FontWeight::LIGHT
    };
    if run.style == "em" {
        face.style = gpui::FontStyle::Italic;
    }
    TextRun {
        len: run.text.len(),
        font: face,
        color: (if run.style == "diff-add" {
            theme().success
        } else if run.style == "diff-remove" {
            theme().danger
        } else if run.style == "link" {
            theme().accent
        } else {
            theme().text
        })
        .into(),
        background_color: if run.style == "code" {
            Some(theme().surface.into())
        } else {
            None
        },
        underline: None,
        strikethrough: if run.style == "strike" {
            Some(gpui::StrikethroughStyle {
                thickness: px(1.),
                color: None,
            })
        } else {
            None
        },
    }
}
