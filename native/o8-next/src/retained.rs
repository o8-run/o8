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
    point, px, size,
};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct PaintedGeometry {
    pub row: Bounds<Pixels>,
    pub backdrop: Option<Bounds<Pixels>>,
    pub text_origin: Option<Point<Pixels>>,
}

#[cfg(test)]
#[path = "retained/geometry_tests.rs"]
mod geometry_tests;

#[path = "retained/user_bubble.rs"]
mod user_bubble;

#[path = "retained/text.rs"]
mod row_text;
use row_text::{file_tip, is_item, link_target, text_run};

pub struct RowState {
    pub row: Row,
    pub layouts: usize,
    #[cfg(test)]
    pub(crate) painted_geometry: RefCell<PaintedGeometry>,
    expanded: Option<bool>,
    /// The reader opened or closed this trace, so updates keep that choice
    /// instead of holding a running trace open.
    chosen: bool,
    cache: Option<Layout>,
    diagram_sources: BTreeSet<usize>,
    diagram_list: Option<(gpui::ListState, usize)>,
    pub(crate) images: crate::ui::images::Cache,
    pub cards: crate::visualizations::Cards,
    /// The workspace a transcript row belongs to, so its file pills can say
    /// where they point.
    pub(crate) file_root: Option<gpui::SharedString>,
    pub(crate) subagents: Option<gpui::Entity<crate::subagents::Inspector>>,
    pub(crate) subagent_agents: Rc<Vec<crate::subagents::model::Agent>>,
    pub(crate) subagent_focus: std::collections::HashMap<String, gpui::FocusHandle>,
    /// The steps of a reply still fading in, oldest first.
    pub(crate) fading: Vec<crate::stream::RevealStep>,
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
        crate::trace::note(&row);
        let expanded = (matches!(&row, Row::Activity { .. })
            || matches!(&row, Row::Message { nodes, .. } if nodes.iter().any(crate::rich::system_event)))
        .then_some(false);
        Self {
            row,
            layouts: 0,
            #[cfg(test)]
            painted_geometry: RefCell::new(PaintedGeometry::default()),
            expanded,
            chosen: false,
            cache: None,
            diagram_sources: BTreeSet::new(),
            diagram_list: None,
            images: Default::default(),
            cards: Default::default(),
            file_root: None,
            subagents: None,
            subagent_agents: Default::default(),
            subagent_focus: Default::default(),
            fading: vec![],
        }
    }
    /// A row that changed in place (a tool step finished) keeps its disclosure;
    /// a trace watched while live stays open once it finishes.
    pub fn keep_disclosure(&mut self, previous: &RowState) {
        self.subagent_focus = previous.subagent_focus.clone();
        self.diagram_sources = previous.diagram_sources.clone();
        if self.expanded.is_some() && previous.expanded.is_some() {
            self.expanded = previous.expanded;
            self.chosen = previous.chosen;
        }
        if let (Row::Activity { .. }, Row::Activity { trace, .. }) = (&self.row, &previous.row)
            && trace.live
            && !self.chosen
        {
            self.expanded = Some(true);
        }
    }
    pub(crate) fn bind_subagent_focus(&mut self, cx: &App) {
        if let Row::Activity { steps, trace, .. } = &self.row {
            for item in crate::subagents::trace::items(steps, trace, &self.subagent_agents) {
                self.subagent_focus
                    .entry(item.id)
                    .or_insert_with(|| cx.focus_handle());
            }
        }
    }
    pub(crate) fn disclosure(&self) -> bool {
        self.expanded.unwrap_or(false)
    }
    /// Whether a trace shows its lines: a running one stays open until the
    /// reader closes it.
    pub(crate) fn trace_open(&self, live: bool) -> bool {
        if live && !self.chosen {
            true
        } else {
            self.disclosure()
        }
    }
    /// The reader's click on a trace header, from what it showed.
    pub(crate) fn choose_disclosure(&mut self, open: bool) {
        if self.expanded.is_some() {
            self.expanded = Some(open);
            self.chosen = true;
            self.cache = None;
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
/// Where a link sits in a row, one spot per wrapped line.
struct LinkSpot {
    bounds: Bounds<Pixels>,
    url: String,
}
struct Layout {
    size: Size<Pixels>,
    /// The appearance its colors were shaped in.
    theme: u8,
    lines: Vec<Line>,
    backgrounds: Vec<Backdrop>,
    images: Vec<Thumbnail>,
    links: Vec<LinkSpot>,
    cards: Vec<(String, Bounds<Pixels>)>,
    diagrams: Vec<crate::transcript_diagram::Placement>,
}
struct Builder {
    row_id: String,
    image_cache: crate::ui::images::Cache,
    width: Pixels,
    y: Pixels,
    lines: Vec<Line>,
    backgrounds: Vec<Backdrop>,
    images: Vec<Thumbnail>,
    links: Vec<LinkSpot>,
    diagrams: Vec<crate::transcript_diagram::Placement>,
    diagram_sources: BTreeSet<usize>,
    /// Where the last paragraph gap ended, so blank lines collapse to one gap.
    gap_end: Option<Pixels>,
}
// The desktop transcript's prose: 14px on a 23.8px line, with a paragraph gap.
const PROSE: (f32, f32) = (14., 24.);
const PARAGRAPH_GAP: f32 = 22.;
/// A message's blocks without trailing blank lines, which would only pad its end.
fn trimmed(nodes: &[Node]) -> &[Node] {
    let end = nodes
        .iter()
        .rposition(|n| n.kind != "break")
        .map_or(0, |i| i + 1);
    &nodes[..end]
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
                        links: vec![],
                        width: width + px(48.),
                        y: top,
                        lines: vec![],
                        backgrounds: vec![],
                        gap_end: None,
                        diagrams: vec![],
                        diagram_sources: self.diagram_sources.clone(),
                    };
                    let mut runs: Vec<Run> =
                        serde_json::from_value(cell.clone()).unwrap_or_default();
                    if row_index == 0 {
                        for run in &mut runs {
                            run.style = "strong".into();
                        }
                    }
                    builder.text(&runs, PROSE.0, PROSE.1, 0., window);
                    let shift = point(width * column as f32, px(0.));
                    if data["aligns"][column].as_str().is_none_or(|a| a == "left") {
                        for mut link in builder.links {
                            link.bounds.origin += shift;
                            self.links.push(link);
                        }
                        for mut pill in builder.backgrounds {
                            pill.bounds.origin += shift;
                            self.backgrounds.push(pill);
                        }
                    }
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
    /// Finds a link on one shaped line and marks each wrapped piece of it.
    fn link(
        &mut self,
        line: &WrappedLine,
        offset: usize,
        span: &std::ops::Range<usize>,
        url: &str,
        (inset, line_height): (Pixels, f32),
    ) {
        let start = span.start.max(offset) - offset;
        let end = span.end.min(offset + line.len()).saturating_sub(offset);
        let pill = is_item(url);
        let mut pieces: Vec<(Pixels, Pixels, Pixels)> = vec![];
        for (index, _) in line.text.char_indices().chain([(line.len(), ' ')]) {
            if index < start || index > end {
                continue;
            }
            let Some(at) = line.position_for_index(index, px(line_height)) else {
                continue;
            };
            match pieces.last_mut() {
                Some(piece) if piece.2 == at.y => piece.1 = at.x,
                _ => pieces.push((at.x, at.x, at.y)),
            }
        }
        for (from, to, y) in pieces.into_iter().filter(|(from, to, _)| to > from) {
            let bounds = Bounds::new(
                point(inset + from - px(4.), self.y + y + px(2.)),
                size(to - from + px(8.), px(line_height - 4.)),
            );
            if pill {
                self.backgrounds.push(Backdrop {
                    bounds,
                    color: theme().selection,
                    radius: px(6.),
                });
            }
            self.links.push(LinkSpot {
                bounds,
                url: url.to_owned(),
            });
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
        let origin = px(24. + inset);
        let (mut start, mut offset) = (0, 0);
        let spans: Vec<_> = runs
            .iter()
            .map(|run| {
                let at = start..start + run.text.len();
                start = at.end;
                at
            })
            .collect();
        for line in lines {
            let height = line.size(px(line_height)).height;
            for (run, span) in runs.iter().zip(&spans) {
                if let Some(url) = link_target(run) {
                    self.link(&line, offset, span, url, (origin, line_height));
                }
            }
            offset += line.len() + 1;
            self.lines.push(Line {
                line,
                origin: point(origin, self.y),
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
        if let Some(card) = crate::transcript_diagram::Placement::new(
            node,
            self.diagrams.len(),
            point(px(24.), self.y + px(8.)),
            (self.width - px(48.)).max(px(1.)),
            &self.diagram_sources,
            window,
        ) {
            self.y = card.bounds.bottom() + px(8.);
            let shown = card.shown;
            self.diagrams.push(card);
            if !shown {
                return;
            }
        }
        if let Some(data) = &node.data {
            self.rich_node(&node.kind, data, expanded, window);
            return;
        }
        if node.kind == "break" {
            // A blank line is classic's paragraph margin: once, and never
            // before the first block.
            if self.gap_end != Some(self.y)
                && (!self.lines.is_empty()
                    || !self.backgrounds.is_empty()
                    || !self.diagrams.is_empty())
            {
                self.y += px(PARAGRAPH_GAP);
                self.gap_end = Some(self.y);
            }
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
                if code { 12. } else { PROSE.0 },
                if code { 19.5 } else { PROSE.1 },
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
    diagram_sources: &BTreeSet<usize>,
    window: &Window,
) -> Layout {
    let mut b = Builder {
        row_id: row.id().into(),
        image_cache: images,
        images: vec![],
        links: vec![],
        width,
        y: px(8.),
        lines: vec![],
        backgrounds: vec![],
        gap_end: None,
        diagrams: vec![],
        diagram_sources: diagram_sources.clone(),
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
        Row::Message {
            role,
            author,
            nodes,
            ..
        } if role == "user" && author.as_ref().is_none_or(|a| a["kind"] != "bot") => {
            user_bubble::layout(&mut b, width, nodes, expanded, window);
        }
        Row::Message { author, nodes, .. } => {
            if let Some(author) = author.as_ref().filter(|a| a["kind"] == "bot") {
                b.plain(
                    crate::text::sanitize(author["name"].as_str().unwrap_or("Bot")),
                    12.,
                    18.,
                    window,
                );
                b.y += px(4.);
            }
            for node in trimmed(nodes) {
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
                    theme: crate::theme::generation(),
                    lines: b.lines,
                    backgrounds: b.backgrounds,
                    images: vec![],
                    links: b.links,
                    cards: vec![],
                    diagrams: vec![],
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
        theme: crate::theme::generation(),
        lines: b.lines,
        backgrounds: b.backgrounds,
        images: b.images,
        links: b.links,
        cards: placements,
        diagrams: b.diagrams,
    }
}
/// The desktop transcript's reading column: the chat width plus the 24px row insets.
pub(crate) fn reading_column() -> f32 {
    crate::theme::chat_width() + 48.
}

/// Whether the reader sits at the end of the transcript, so new rows follow.
pub(crate) fn at_end(list: &gpui::ListState) -> bool {
    let end = list.max_offset_for_scrollbar().height;
    (-list.scroll_px_offset_for_scrollbar().y) >= end - px(48.)
}

/// Keeps the last row's end at the bottom; the list settles the overshoot once
/// it has measured the row, however tall.
pub(crate) fn pin_end(list: &gpui::ListState) {
    if let Some(item_ix) = list.item_count().checked_sub(1) {
        list.scroll_to(gpui::ListOffset {
            item_ix,
            offset_in_item: px(1_000_000.),
        });
    }
}

/// Hands the steps still fading in to the row holding the end of the reply.
pub(crate) fn mark_fading(rows: &[Rc<RefCell<RowState>>], fading: Vec<crate::stream::RevealStep>) {
    let last = rows.iter().rposition(
        |row| matches!(&row.borrow().row, Row::Message { role, .. } if role == "assistant"),
    );
    for (index, row) in rows.iter().enumerate() {
        let mut row = row.borrow_mut();
        if Some(index) == last {
            row.fading.clone_from(&fading);
        } else if !row.fading.is_empty() {
            row.fading.clear();
        }
    }
}

/// How visible each of the last characters is: every step fades in on its own
/// clock, and its words follow one another across the stagger.
fn tail_alphas(steps: &[crate::stream::RevealStep], now: std::time::Instant) -> Vec<f32> {
    use crate::stream::{REVEAL_FADE, REVEAL_STAGGER};
    let mut alphas = Vec::new();
    for step in steps.iter().rev() {
        let age = now.saturating_duration_since(step.at).as_secs_f32();
        for char in (0..step.chars).rev() {
            let delay = REVEAL_STAGGER.as_secs_f32() * char as f32 / step.chars.max(1) as f32;
            let t = ((age - delay) / REVEAL_FADE.as_secs_f32()).clamp(0., 1.);
            alphas.push(1. - (1. - t) * (1. - t));
        }
    }
    alphas
}

/// The lines at the end of the row with what is still fading in them, as byte
/// spans. The tail is counted in characters from the end, so Markdown's marks
/// shift it by at most a few characters.
fn tail_fades(
    steps: &[crate::stream::RevealStep],
    lines: &[Line],
) -> Vec<(usize, Vec<(std::ops::Range<usize>, f32)>)> {
    if steps.is_empty() {
        return vec![];
    }
    let mut alphas = tail_alphas(steps, std::time::Instant::now()).into_iter();
    let mut fades = Vec::new();
    for (index, line) in lines.iter().enumerate().rev() {
        let mut spans: Vec<(std::ops::Range<usize>, f32)> = Vec::new();
        let text = line.line.text.as_ref();
        let mut exhausted = false;
        for (at, char) in text.char_indices().rev() {
            let Some(alpha) = alphas.next() else {
                exhausted = true;
                break;
            };
            if alpha < 1. {
                spans.push((at..at + char.len_utf8(), alpha));
            }
        }
        if !spans.is_empty() {
            spans.reverse();
            fades.push((index, spans));
        }
        if exhausted {
            break;
        }
    }
    fades
}

pub struct RetainedRow {
    pub state: Rc<RefCell<RowState>>,
    pub index: usize,
    pub painted: Rc<RefCell<BTreeSet<usize>>>,
}
impl RetainedRow {
    pub fn interactive(self, list: &gpui::ListState) -> gpui::AnyElement {
        use gpui::prelude::*;
        self.state.borrow_mut().diagram_list = Some((list.clone(), self.index));
        if matches!(self.state.borrow().row, Row::Activity { .. }) {
            return crate::trace::element(self.state.clone(), self.index, list);
        }
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
            let column = width.min(px(reading_column()));
            let mut state = state.borrow_mut();
            if state.cache.as_ref().is_none_or(|cache| {
                cache.size.width != column || cache.theme != crate::theme::generation()
            }) {
                state.cache = Some(layout(
                    &state.row,
                    column,
                    state.expanded.unwrap_or(false),
                    state.images.clone(),
                    &state.cards,
                    &state.diagram_sources,
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
        let cache = state.cache.as_ref().expect("measured row");
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
        let controls: Vec<_> = cache
            .diagrams
            .iter()
            .enumerate()
            .flat_map(|(index, card)| {
                let state = self.state.clone();
                card.controls(
                    self.index,
                    index,
                    origin,
                    move |window, _| {
                        let mut state = state.borrow_mut();
                        if !state.diagram_sources.remove(&index) {
                            state.diagram_sources.insert(index);
                        }
                        state.cache = None;
                        if let Some((list, index)) = &state.diagram_list {
                            list.splice(*index..*index + 1, 1);
                        }
                        window.refresh();
                    },
                    window,
                    cx,
                )
            })
            .collect();
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
                        .child(
                            img(data.clone())
                                .size_full()
                                .rounded(px(10.))
                                .object_fit(ObjectFit::Contain),
                        )
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
            .collect::<Vec<_>>()
            .into_iter()
            .chain(cache.links.iter().enumerate().map(|(index, link)| {
                let url = link.url.clone();
                // Unique across rows: elements sharing an id share click state,
                // and one row's mouse-up then cancels another's press.
                let selector = format!("transcript-link-{}-{index}", self.index);
                let name = SharedString::from(selector.clone());
                let root = state.file_root.as_ref().map(|root| root.as_ref());
                let tip = file_tip(root, &url).map(SharedString::from);
                let mut child = div()
                    .id(name)
                    .debug_selector(move || selector.clone())
                    .w(link.bounds.size.width)
                    .h(link.bounds.size.height)
                    .cursor_pointer()
                    .on_click(move |_, window, cx| crate::ui::open_link(&url, window, cx))
                    .when_some(tip, |link, tip| {
                        link.tooltip(move |_, cx| {
                            cx.new(|_| crate::icon::Tip(tip.clone())).into()
                        })
                    })
                    .into_any_element();
                child.layout_as_root(link.bounds.size.map(AvailableSpace::Definite), window, cx);
                child.prepaint_at(origin + link.bounds.origin, window, cx);
                child
            }))
            .chain(controls)
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
        #[cfg(test)]
        state.painted_geometry.replace(PaintedGeometry {
            row: bounds,
            ..Default::default()
        });
        for background in &cache.backgrounds {
            let painted_bounds =
                Bounds::new(origin + background.bounds.origin, background.bounds.size);
            #[cfg(test)]
            state
                .painted_geometry
                .borrow_mut()
                .backdrop
                .get_or_insert(painted_bounds);
            window.paint_quad(
                gpui::fill(painted_bounds, background.color).corner_radii(background.radius),
            );
        }
        for card in &cache.diagrams {
            card.paint(origin, window, cx);
        }
        let fades = tail_fades(&state.fading, &cache.lines);
        if !fades.is_empty() {
            window.request_animation_frame();
        }
        for (index, line) in cache.lines.iter().enumerate() {
            let painted_origin = origin + line.origin;
            #[cfg(test)]
            state
                .painted_geometry
                .borrow_mut()
                .text_origin
                .get_or_insert(painted_origin);
            let faded = fades
                .iter()
                .find(|(line, _)| *line == index)
                .map(|(_, spans)| line.line.with_alpha(spans));
            let text = faded.as_ref().unwrap_or(&line.line);
            text.paint_background(painted_origin, line.height, line.align, None, window, cx)
                .unwrap();
            text.paint(painted_origin, line.height, line.align, None, window, cx)
                .unwrap();
        }
        for image in images {
            image.paint(window, cx);
        }
        self.painted.borrow_mut().insert(self.index);
    }
}

#[cfg(test)]
mod trace_disclosure_tests {
    use super::*;

    fn row(live: bool) -> RowState {
        RowState::new(Row::Activity {
            id: "turn:working".into(),
            steps: vec![],
            trace: crate::model::Trace {
                live,
                ..Default::default()
            },
        })
    }

    #[test]
    fn a_running_trace_folds_on_click_and_stays_folded_through_updates() {
        let mut first = row(true);
        assert!(first.trace_open(true), "a running trace opens by itself");
        first.choose_disclosure(false);
        assert!(!first.trace_open(true));
        let mut update = row(true);
        update.keep_disclosure(&first);
        assert!(!update.trace_open(true), "a new step doesn't reopen it");
        let mut finished = row(false);
        finished.keep_disclosure(&update);
        assert!(!finished.trace_open(false), "nor does finishing");
        finished.choose_disclosure(true);
        assert!(finished.trace_open(false));
    }

    #[test]
    fn an_untouched_running_trace_is_still_open_when_it_finishes() {
        let live = row(true);
        let mut finished = row(false);
        finished.keep_disclosure(&live);
        assert!(finished.trace_open(false));
        assert!(!row(false).trace_open(false), "a saved trace starts folded");
    }
}
