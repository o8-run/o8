//! File Markdown tests use the production entry point and painted text layouts.
use super::*;
use crate::{
    model::Row,
    retained::{RetainedRow, RowState},
    text::Node,
};
use gpui::{ScrollDelta, ScrollWheelEvent, TextLayout, TouchPhase, point};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(in crate::files_panel) struct DocumentView {
    pub text: Vec<(String, TextLayout)>,
}
impl gpui::Global for DocumentView {}

fn document(panel: &Entity<FilesPanel>, cx: &mut VisualTestContext) -> Vec<Node> {
    panel.read_with(cx, |_, cx| {
        let row = cx.global::<RenderedMarkdown>().0.borrow();
        let Row::Message { nodes, .. } = &row.row else {
            panic!("file Markdown row")
        };
        nodes.clone()
    })
}
fn content(node: &Node) -> String {
    node.runs.iter().map(|r| r.text.as_str()).collect()
}
fn open<'a>(
    fixture: &Fixture,
    source: &str,
    cx: &'a mut TestAppContext,
) -> (Entity<FilesPanel>, &'a mut VisualTestContext) {
    fs::write(PathBuf::from(&fixture.repo).join("AGENTS.md"), source).unwrap();
    let (panel, cx) = test_panel(fixture, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-markdown-1");
    (panel, cx)
}

pub(super) fn soft_breaks(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let source = "A paragraph has a source\nline break, and another\nline to reflow.\n\n- A list item continues\n  on the next source line.\n";
    let (panel, cx) = open(&fixture, source, cx);
    let nodes = document(&panel, cx);
    let paragraphs: Vec<_> = nodes
        .iter()
        .filter(|n| n.kind == "p")
        .map(content)
        .collect();
    assert_eq!(
        paragraphs,
        ["A paragraph has a source line break, and another line to reflow."]
    );
    let list: Vec<_> = nodes
        .iter()
        .filter(|n| n.kind == "ul")
        .map(content)
        .collect();
    assert_eq!(list, ["A list item continues on the next source line."]);
    click(cx, "files-tree-toggle");
    cx.simulate_resize(gpui::size(px(380.), px(700.)));
    draw(cx);
    let small = cx.debug_bounds("files-markdown-block-0").unwrap();
    cx.simulate_resize(gpui::size(px(900.), px(700.)));
    draw(cx);
    let large = cx.debug_bounds("files-markdown-block-0").unwrap();
    assert!(
        small.size.height > large.size.height,
        "one paragraph must reflow with available width"
    );
}
pub(super) fn hard_breaks(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = open(
        &fixture,
        "Two spaces  \nstay hard.\n\nBackslash\\\nstays hard.\n\nSoft\nbecomes a space.\n\nA new paragraph.\n",
        cx,
    );
    let nodes = document(&panel, cx);
    let p: Vec<_> = nodes
        .iter()
        .filter(|n| n.kind == "p")
        .map(content)
        .collect();
    assert_eq!(
        p,
        [
            "Two spaces\nstay hard.",
            "Backslash\nstays hard.",
            "Soft becomes a space.",
            "A new paragraph."
        ]
    );
    let rendered = panel.read_with(cx, |_, cx| {
        cx.global::<DocumentView>()
            .text
            .iter()
            .map(|(_, t)| t.text())
            .collect::<Vec<_>>()
    });
    assert!(rendered.contains(&"Two spaces\nstay hard.".into()));
    assert!(rendered.contains(&"Backslash\nstays hard.".into()));
}
pub(super) fn headings(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = open(
        &fixture,
        "# Level one\n\nBody paragraph.\n\n## Level two\n\n### Level three\n",
        cx,
    );
    let sizes = panel.read_with(cx, |_, cx| {
        cx.try_global::<DocumentView>()
            .expect("file preview needs its own heading layout")
            .text
            .iter()
            .map(|(kind, text)| {
                (
                    kind.clone(),
                    text.line_layout_for_index(0).unwrap().font_size(),
                    text.line_height(),
                )
            })
            .collect::<Vec<_>>()
    });
    for (kind, size) in [("h1", 22.), ("h2", 18.), ("h3", 15.), ("p", 13.5)] {
        let (_, actual, line_height) = sizes.iter().find(|(k, _, _)| k == kind).unwrap();
        assert_eq!(*actual, px(size), "classic {kind} font size");
        assert_eq!(
            *line_height,
            px(size * if kind == "p" { 1.55 } else { 1.25 })
        );
    }
    let h1 = cx.debug_bounds("files-markdown-block-0").unwrap();
    let body = cx.debug_bounds("files-markdown-block-1").unwrap();
    let h2 = cx.debug_bounds("files-markdown-block-2").unwrap();
    assert_eq!(body.top() - h1.bottom(), px(8.));
    assert_eq!(h2.top() - body.bottom(), px(18.));
}
pub(super) fn tables(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = open(
        &fixture,
        "| A long meaningful heading | Another useful heading | Third heading |\n| --- | --- | --- |\n| Content width preserves readable cells | The next column stays readable too | Last cell |\n",
        cx,
    );
    click(cx, "files-tree-toggle");
    cx.simulate_resize(gpui::size(px(440.), px(700.)));
    draw(cx);
    let viewport = cx
        .debug_bounds("files-markdown-table-0")
        .expect("table scroll viewport");
    let first = cx.debug_bounds("files-markdown-table-0-cell-0-0").unwrap();
    let last = cx.debug_bounds("files-markdown-table-0-cell-0-2").unwrap();
    assert!(
        last.right() > viewport.right(),
        "intrinsic columns must extend beyond a narrow viewport"
    );
    let text = panel.read_with(cx, |_, cx| {
        cx.global::<DocumentView>()
            .text
            .iter()
            .map(|(_, t)| (t.text(), t.wrapped_text()))
            .collect::<Vec<_>>()
    });
    for (source, rendered) in text {
        assert_eq!(source, rendered, "table cells must not squeeze and wrap");
    }
    cx.simulate_event(ScrollWheelEvent {
        position: viewport.center(),
        delta: ScrollDelta::Pixels(point(px(-200.), px(0.))),
        touch_phase: TouchPhase::Moved,
        modifiers: Default::default(),
    });
    draw(cx);
    assert!(
        cx.debug_bounds("files-markdown-table-0-cell-0-0")
            .unwrap()
            .left()
            < first.left(),
        "horizontal wheel scrolling must reach later columns"
    );
}

struct ChatRow(Rc<RefCell<RowState>>);
impl Render for ChatRow {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(RetainedRow {
            state: self.0.clone(),
            index: 0,
            painted: Default::default(),
        })
    }
}
pub(super) fn chat_unchanged(cx: &mut TestAppContext) {
    let nodes = crate::text::markdown("First chat line\nSecond chat line");
    assert_eq!(
        nodes.iter().map(|n| n.kind.as_str()).collect::<Vec<_>>(),
        ["p", "p"]
    );
    let state = Rc::new(RefCell::new(RowState::new(Row::Message {
        id: "chat-newline-regression".into(),
        role: "assistant".into(),
        nodes,
    })));
    let (_, cx) = cx.add_window_view(|_, _| ChatRow(state.clone()));
    draw(cx);
    assert_eq!(
        state.borrow().rendered().1,
        ["First chat line", "Second chat line"]
    );
}
