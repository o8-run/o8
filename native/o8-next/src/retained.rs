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
    pub(crate) images: crate::ui::images::Cache,
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
    pub(crate) fn invalidate_image_layout(&mut self) {
        self.cache = None;
    }
    pub fn new(row: Row) -> Self {
        let expanded = (matches!(&row, Row::Activity { .. })
            || matches!(&row, Row::Message { nodes, .. } if nodes.iter().any(crate::rich::system_event)))
        .then_some(false);
        Self {
            row,
            layouts: 0,
            expanded,
            cache: None,
            images: Default::default(),
            cards: Default::default(),
        }
    }
    /// A row that changed in place (a tool step finished) keeps its disclosure.
    pub fn keep_disclosure(&mut self, previous: &RowState) {
        if self.expanded.is_some() && previous.expanded.is_some() {
            self.expanded = previous.expanded;
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
    radius: Pixels,
}
struct Thumbnail {
    bounds: Bounds<Pixels>,
    image: Option<std::sync::Arc<gpui::RenderImage>>,
    selector: String,
    name: String,
    unavailable: bool,
}
struct Layout {
    size: Size<Pixels>,
    lines: Vec<Line>,
    backgrounds: Vec<Backdrop>,
    images: Vec<Thumbnail>,
    cards: Vec<(String, Bounds<Pixels>)>,
}
struct Builder {
    row_id: String,
    image_cache: crate::ui::images::Cache,
    width: Pixels,
    y: Pixels,
    lines: Vec<Line>,
    backgrounds: Vec<Backdrop>,
    images: Vec<Thumbnail>,
}
impl Builder {
    fn rich_node(&mut self, kind: &str, data: &serde_json::Value, expanded: bool, window: &Window) {
        if kind == "media" && data["kind"] == "image" {
            self.image(data);
            return;
        }
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
                        row_id: self.row_id.clone(),
                        image_cache: self.image_cache.clone(),
                        images: vec![],
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
                    radius: px(0.),
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
            self.disclosure(&summary, "text", expanded, window);
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
            radius: px(0.),
        });
    }
    /// One truncated summary line with a disclosure chevron.
    fn disclosure(&mut self, summary: &str, style: &str, expanded: bool, window: &Window) {
        let text = format!("{} {summary}", if expanded { "⌄" } else { "›" });
        let mut runs = vec![text_run(&Run {
            style: style.into(),
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
            .expect("disclosure summary")
        {
            self.lines.push(Line {
                line,
                origin: point(px(24.), self.y),
                height: px(18.),
                align: TextAlign::Left,
            });
            self.y += px(18.);
        }
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
    fn image(&mut self, data: &serde_json::Value) {
        use crate::ui::images::ImageState;
        let state = self
            .image_cache
            .borrow()
            .get(data["path"].as_str().unwrap_or(""))
            .cloned();
        let unavailable = matches!(state, Some(ImageState::Unavailable));
        let image = match state {
            Some(ImageState::Ready(image)) => Some(image),
            _ => None,
        };
        let width = (self.width - px(48.)).max(px(1.));
        let dimensions = image.as_ref().map(|image| {
            let pixels = image.size(0);
            let scale = (f32::from(width) / pixels.width.0 as f32)
                .min(240. / pixels.height.0 as f32)
                .min(1.);
            size(
                pixels.width.0 as f32 * scale,
                pixels.height.0 as f32 * scale,
            )
        });
        let dimensions = dimensions
            .map(|s| s.map(px))
            .unwrap_or(size(width, px(18.)));
        let index = self.images.len();
        self.images.push(Thumbnail {
            bounds: Bounds::new(point(px(24.), self.y + px(4.)), dimensions),
            selector: format!(
                "transcript-image-{}{}-{index}",
                if unavailable { "error-" } else { "" },
                self.row_id
            ),
            name: data["name"].as_str().unwrap_or("Image").to_owned(),
            image,
            unavailable,
        });
        self.y += dimensions.height + px(12.);
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
                radius: px(0.),
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
                radius: px(0.),
            });
        }
    }
}
fn layout(
    row: &Row,
    width: Pixels,
    expanded: bool,
    images: crate::ui::images::Cache,
    cards: &crate::visualizations::Cards,
    window: &Window,
) -> Layout {
    let mut b = Builder {
        row_id: row.id().into(),
        image_cache: images,
        images: vec![],
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
        Row::Message { role, nodes, .. } if role == "user" => {
            // The desktop user bubble: right-aligned and sized to its text, at most
            // 80% of the reading column.
            let pad = px(12.);
            let top = b.y + px(4.);
            let mut bubble = Builder {
                row_id: b.row_id.clone(),
                image_cache: b.image_cache.clone(),
                images: vec![],
                width: ((width - px(48.)) * 0.8).max(px(1.)) + px(48.),
                y: top + px(8.),
                lines: vec![],
                backgrounds: vec![],
            };
            for node in nodes {
                bubble.node(node, expanded, window);
            }
            let text = bubble
                .lines
                .iter()
                .map(|line| line.origin.x - px(24.) + line.line.width())
                .chain(
                    bubble
                        .images
                        .iter()
                        .map(|image| image.bounds.right() - px(24.)),
                )
                .fold(px(1.), Pixels::max);
            let right = width - px(24.);
            let shift = right - pad - text - px(24.);
            b.backgrounds.push(Backdrop {
                bounds: Bounds::new(
                    point(right - text - pad * 2., top),
                    size(text + pad * 2., bubble.y - top + px(8.)),
                ),
                color: theme().selection,
                radius: px(14.),
            });
            for mut background in bubble.backgrounds {
                background.bounds.origin.x += shift;
                b.backgrounds.push(background);
            }
            for mut line in bubble.lines {
                line.origin.x += shift;
                b.lines.push(line);
            }
            for mut image in bubble.images {
                image.bounds.origin.x += shift;
                b.images.push(image);
            }
            b.y = bubble.y + px(16.);
        }
        Row::Message { nodes, .. } => {
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
            b.y += px(8.);
        }
        Row::Activity { steps, .. } => {
            // The desktop's quiet counted rollup; each step opens under it.
            b.y += px(2.);
            b.disclosure(
                &crate::text::sanitize(&crate::activity::summary(steps)),
                "muted",
                expanded,
                window,
            );
            if !expanded {
                b.y += px(2.);
                return Layout {
                    size: size(width, b.y + px(8.)),
                    lines: b.lines,
                    backgrounds: b.backgrounds,
                    images: b.images,
                    cards: vec![],
                };
            }
            b.y += px(4.);
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
        images: b.images,
        cards: placements,
    }
}
// The desktop transcript's reading column: the composer width plus the 24px row insets.
const COLUMN: f32 = crate::theme::GEOMETRY.composer_width + 48.;

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
            let expanded = state.expanded.as_mut().expect("collapsible row");
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
    type PrepaintState = Vec<gpui::AnyElement>;
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
            // Rows wrap at the reading column and paint centred in wider panes.
            let column = width.min(px(COLUMN));
            let mut state = state.borrow_mut();
            if state
                .cache
                .as_ref()
                .is_none_or(|cache| cache.size.width != column)
            {
                state.cache = Some(layout(
                    &state.row,
                    column,
                    state.expanded.unwrap_or(false),
                    state.images.clone(),
                    &state.cards,
                    window,
                ));
                state.layouts += 1;
            }
            size(width, state.cache.as_ref().unwrap().size.height)
        });
        (id, ())
    }
    fn prepaint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        row_bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Vec<gpui::AnyElement> {
        use gpui::{prelude::*, *};
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
        let cache = state.cache.as_ref().unwrap();
        // The same centred column origin that paint uses for text and backdrops.
        let origin = row_bounds.origin
            + point(
                ((row_bounds.size.width - cache.size.width) / 2.).max(px(0.)),
                px(0.),
            );
        for (id, placement) in &cache.cards {
            if let Some(card) = state.cards.get(id) {
                card.borrow_mut().paint(
                    Bounds::new(origin + placement.origin, placement.size),
                    window.content_mask().bounds,
                    window,
                );
            }
        }
        cache
            .images
            .iter()
            .map(|image| {
                let selector = image.selector.clone();
                let mut child = div()
                    .id(SharedString::from(selector.clone()))
                    .debug_selector(move || selector.clone())
                    .w(image.bounds.size.width)
                    .h(image.bounds.size.height);
                if let Some(data) = &image.image {
                    let data = data.clone();
                    let name = image.name.clone();
                    child = child
                        .cursor_pointer()
                        .child(img(data.clone()).size_full().object_fit(ObjectFit::Contain))
                        .on_click(move |_, _, cx| {
                            crate::ui::images::open(data.clone(), name.clone(), cx)
                        });
                } else {
                    child = child
                        .text_size(px(12.))
                        .text_color(theme().text_muted)
                        .child(if image.unavailable {
                            "Image unavailable"
                        } else {
                            "Loading image..."
                        });
                }
                let mut child = child.into_any_element();
                child.layout_as_root(image.bounds.size.map(AvailableSpace::Definite), window, cx);
                child.prepaint_at(origin + image.bounds.origin, window, cx);
                child
            })
            .collect()
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        images: &mut Vec<gpui::AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let state = self.state.borrow();
        let cache = state.cache.as_ref().expect("measured row");
        let origin = bounds.origin
            + point(
                ((bounds.size.width - cache.size.width) / 2.).max(px(0.)),
                px(0.),
            );
        for background in &cache.backgrounds {
            window.paint_quad(
                gpui::fill(
                    Bounds::new(origin + background.bounds.origin, background.bounds.size),
                    background.color,
                )
                .corner_radii(background.radius),
            );
        }
        for line in &cache.lines {
            line.line
                .paint_background(
                    origin + line.origin,
                    line.height,
                    line.align,
                    None,
                    window,
                    cx,
                )
                .unwrap();
            line.line
                .paint(
                    origin + line.origin,
                    line.height,
                    line.align,
                    None,
                    window,
                    cx,
                )
                .unwrap();
        }
        for image in images {
            image.paint(window, cx);
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
        } else if run.style == "muted" {
            theme().text_muted
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
