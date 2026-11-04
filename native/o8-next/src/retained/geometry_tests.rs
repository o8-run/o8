use super::*;
use gpui::{Context, Render, TestAppContext, div, prelude::*};

struct TranscriptRow(Rc<RefCell<RowState>>);
impl Render for TranscriptRow {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(RetainedRow {
            state: self.0.clone(),
            index: 0,
            painted: Default::default(),
        })
    }
}

#[gpui::test]
fn bot_network_peer_author_uses_peer_layout_even_with_a_user_transport_role(
    cx: &mut TestAppContext,
) {
    let state = Rc::new(RefCell::new(RowState::new(
        crate::model::render_tree(&[serde_json::from_value(
            serde_json::json!({ "id":"peer", "role":"user", "text":"A peer turn",
            "author":{"kind":"bot","name":"OriginalPeer","id":"bot-peer"} }),
        )
        .unwrap()])
        .remove(0),
    )));
    let (_, cx) = cx.add_window_view(|_, _| TranscriptRow(state.clone()));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    let state = state.borrow();
    assert_eq!(serde_json::to_value(&state.row).unwrap()["role"], "user");
    assert_eq!(
        serde_json::to_value(&state.row).unwrap()["author"]["name"],
        "OriginalPeer"
    );
    let layout = state
        .cache
        .as_ref()
        .expect("production retained row reached layout");
    assert!(
        layout.backgrounds.is_empty(),
        "a peer turn must not receive the human bubble backdrop"
    );
}

#[gpui::test]
fn user_rich_backdrops_stay_inside_bubble_and_reading_column(cx: &mut TestAppContext) {
    let cases = [
        (
            "fenced code",
            crate::text::markdown("Here is the code:\n\n```text\nx\n```"),
        ),
        ("rule", crate::text::markdown("Short\n\n---")),
        (
            "media",
            vec![Node {
                fence_closed: false,
                kind: "media".into(),
                runs: vec![],
                language: None,
                data: Some(
                    serde_json::json!({"kind":"image", "name":"a", "mimeType":"image/png", "path":"a.png"}),
                ),
            }],
        ),
    ];
    let state = Rc::new(RefCell::new(RowState::new(Row::Message {
        id: "user-rich".into(),
        role: "user".into(),
        author: None,
        nodes: vec![],
    })));
    let (_, cx) = cx.add_window_view(|_, _| TranscriptRow(state.clone()));
    cx.simulate_resize(size(px(1680.), px(1050.)));
    for (name, nodes) in cases {
        *state.borrow_mut() = RowState::new(Row::Message {
            id: "user-rich".into(),
            role: "user".into(),
            author: None,
            nodes,
        });
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        let state = state.borrow();
        let layout = state
            .cache
            .as_ref()
            .expect("real retained row reached layout and paint");
        assert_eq!(
            layout.size.width,
            px(768.),
            "wide rows use the reading column"
        );
        // A picture is a thumbnail rather than a backdrop; it must fit the
        // bubble the same way.
        let bubble = layout.backgrounds[0].bounds;
        let rich: Vec<Bounds<Pixels>> = layout.backgrounds[1..]
            .iter()
            .map(|b| b.bounds)
            .chain(layout.images.iter().map(|image| image.bounds))
            .collect();
        assert!(!rich.is_empty(), "{name} must have its own rich backdrop");
        let right = rich
            .iter()
            .chain([&bubble])
            .map(|b| b.right())
            .fold(px(0.), Pixels::max);
        println!(
            "{name}: column_width={} backdrop_right={} bubble={bubble:?}",
            f32::from(layout.size.width),
            f32::from(right)
        );
        assert!(
            right <= layout.size.width,
            "{name}: user rich backdrop escapes the reading column: {right:?} > {:?}",
            layout.size.width
        );
        for bounds in &rich {
            assert!(
                bounds.left() >= bubble.left() && bounds.right() <= bubble.right(),
                "{name}: rich backdrop {bounds:?} escapes bubble {bubble:?}"
            );
        }
    }
}

#[gpui::test]
fn mermaid_retained_stream_copy_toggle_and_fallback(cx: &mut TestAppContext) {
    let source = "flowchart TD\nA[Start] -->|ready| B{Check}\nB --> C([Done])";
    let message = |text: &str| {
        crate::model::render_tree(&[serde_json::from_value(serde_json::json!({
            "id":"diagram", "role":"assistant", "text":text,
        }))
        .unwrap()])
        .remove(0)
    };
    let state = Rc::new(RefCell::new(RowState::new(message(&format!(
        "```mermaid\n{source}"
    )))));
    let (_, cx) = cx.add_window_view(|_, _| TranscriptRow(state.clone()));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert!(
        state
            .borrow()
            .rendered()
            .1
            .iter()
            .any(|s| s.contains("flowchart"))
    );
    *state.borrow_mut() = RowState::new(message(&format!("```mermaid\n{source}\n```")));
    for width in [360., 900., 1680.] {
        cx.simulate_resize(size(px(width), px(1050.)));
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        let copy = cx
            .debug_bounds("mermaid-0-0-copy")
            .expect("closed fence gets a native card");
        assert!(copy.right() <= px(width));
    }
    let layouts = state.borrow().layouts;
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert_eq!(
        state.borrow().layouts,
        layouts,
        "repaints reuse diagram layout"
    );
    let copy = cx.debug_bounds("mermaid-0-0-copy").unwrap();
    cx.simulate_click(copy.center(), gpui::Modifiers::default());
    cx.update(|_, cx| {
        assert_eq!(
            cx.read_from_clipboard().unwrap().text().as_deref(),
            Some(source)
        )
    });
    let toggle = cx.debug_bounds("mermaid-0-0-source").unwrap();
    cx.simulate_click(toggle.center(), gpui::Modifiers::default());
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert!(
        state
            .borrow()
            .rendered()
            .1
            .iter()
            .any(|s| s.contains("flowchart"))
    );
    cx.simulate_click(toggle.center(), gpui::Modifiers::default());
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert!(
        !state
            .borrow()
            .rendered()
            .1
            .iter()
            .any(|s| s.contains("flowchart"))
    );
    *state.borrow_mut() = RowState::new(message(&format!(
        "```mermaid\n{source}\n```\n\n```mermaid\n{source}\n```"
    )));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    let toggle = cx.debug_bounds("mermaid-0-0-source").unwrap();
    cx.simulate_click(toggle.center(), gpui::Modifiers::default());
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert_eq!(
        state
            .borrow()
            .rendered()
            .1
            .iter()
            .filter(|s| s.contains("flowchart"))
            .count(),
        1,
        "identical diagrams have independent source toggles"
    );
    let oversize = format!("flowchart TD\n{}", "A-->B\n".repeat(201));
    for invalid in ["garbage", oversize.as_str()] {
        *state.borrow_mut() = RowState::new(message(&format!("```mermaid\n{invalid}\n```")));
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        let state = state.borrow();
        assert!(
            state
                .rendered()
                .1
                .iter()
                .any(|s| s.contains(invalid.lines().next().unwrap()))
        );
        assert_eq!(
            state.cache.as_ref().unwrap().backgrounds.len(),
            1,
            "plain code fallback"
        );
    }
}

/// Renders one closed fence and checks it is a native card with the given
/// drawn boxes or bars, lines and commit dots, and that Copy source works.
fn assert_native_card(cx: &mut TestAppContext, source: &str, counts: (usize, usize, usize)) {
    let message = |text: &str| {
        crate::model::render_tree(&[serde_json::from_value(serde_json::json!({
            "id":"diagram", "role":"assistant", "text":text,
        }))
        .unwrap()])
        .remove(0)
    };
    let state = Rc::new(RefCell::new(RowState::new(message(&format!(
        "```mermaid\n{source}\n```"
    )))));
    let (_, cx) = cx.add_window_view(|_, _| TranscriptRow(state.clone()));
    let header = source.lines().next().unwrap();
    for width in [360., 900.] {
        cx.simulate_resize(size(px(width), px(1050.)));
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        let copy = cx
            .debug_bounds("mermaid-0-0-copy")
            .unwrap_or_else(|| panic!("{header} gets a native card"));
        assert!(copy.right() <= px(width));
        let state = state.borrow();
        let diagrams = &state.cache.as_ref().unwrap().diagrams;
        assert_eq!(diagrams.len(), 1, "{header}");
        assert_eq!(diagrams[0].counts(), counts, "{header}");
        assert!(
            !state.rendered().1.iter().any(|s| s.contains(header)),
            "{header} source stays hidden until asked for"
        );
    }
    let copy = cx.debug_bounds("mermaid-0-0-copy").unwrap();
    cx.simulate_click(copy.center(), gpui::Modifiers::default());
    cx.update(|_, cx| {
        assert_eq!(
            cx.read_from_clipboard().unwrap().text().as_deref(),
            Some(source)
        )
    });
}

#[gpui::test]
fn mermaid_er_diagram_renders_as_a_native_card(cx: &mut TestAppContext) {
    // Four entities, three relationships.
    assert_native_card(
        cx,
        "erDiagram\nCUSTOMER ||--o{ ORDER : places\nORDER ||--|{ LINE-ITEM : contains\nCUSTOMER }|..|{ ADDRESS : uses\nCUSTOMER {\n  string name\n  string id PK\n}",
        (4, 3, 0),
    );
}

#[gpui::test]
fn mermaid_git_graph_renders_as_a_native_card(cx: &mut TestAppContext) {
    // Six commit dots joined by six parent lines, one of them a merge.
    assert_native_card(
        cx,
        "gitGraph\ncommit\ncommit id: \"base\"\nbranch develop\ncheckout develop\ncommit\ncommit tag: \"v1\"\ncheckout main\nmerge develop\ncommit",
        (0, 6, 6),
    );
}

#[gpui::test]
fn mermaid_gantt_chart_renders_as_a_native_card(cx: &mut TestAppContext) {
    // Three bars and a milestone.
    assert_native_card(
        cx,
        "gantt\ntitle Demo day\ndateFormat YYYY-MM-DD\nsection Build\nDesign :a1, 2026-11-02, 3d\nCode :after a1, 5d\nsection Ship\nReview :crit, 2026-11-10, 2026-11-12\nDemo :milestone, 2026-11-12, 0d",
        (4, 0, 0),
    );
}

#[gpui::test]
fn mermaid_mindmap_renders_as_a_native_card(cx: &mut TestAppContext) {
    // Seven nodes, six branches.
    assert_native_card(
        cx,
        "mindmap\n  root((o8))\n    Native\n      GPUI\n      Mermaid\n    Web\n      React\n    [Docs]",
        (7, 6, 0),
    );
}

#[gpui::test]
fn a_file_pill_peeks_at_its_lines_after_a_pause(cx: &mut TestAppContext) {
    let mut state = RowState::new(Row::Message {
        id: "pill".into(),
        role: "assistant".into(),
        author: None,
        nodes: crate::text::markdown("See `src/deep/a.rs:5` and https://example.com/x/y now."),
    });
    let peeks = crate::transcript_peek::Peeks::default();
    let file: String = (1..=20).map(|n| format!("fn line_{n}() {{}}\n")).collect();
    // Read lately, so the peek shows it with no server to ask.
    peeks.remember("/repo/src/deep/a.rs", &file);
    state.file_root = Some("/repo".into());
    state.peeks = Some(peeks);
    let state = Rc::new(RefCell::new(state));
    let (_, cx) = cx.add_window_view(|_, _| TranscriptRow(state.clone()));
    cx.simulate_resize(size(px(900.), px(700.)));
    let draw = |cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        })
    };
    draw(cx);
    let text = state.borrow().rendered().1.join("\n");
    assert!(text.contains(&format!("{ICON_ROOM}a.rs:5")), "{text}");
    assert!(text.contains(&format!("{ICON_ROOM}example.com")), "{text}");
    assert!(
        !text.contains("src/deep") && !text.contains("/x/y"),
        "{text}"
    );
    let pill = cx.debug_bounds("transcript-link-0-0").expect("file pill");
    cx.simulate_mouse_move(pill.center(), None, gpui::Modifiers::default());
    draw(cx);
    cx.executor()
        .advance_clock(crate::transcript_peek::OPEN_DELAY / 2);
    cx.run_until_parked();
    draw(cx);
    assert!(cx.debug_bounds("transcript-peek").is_none(), "not yet");
    cx.executor()
        .advance_clock(crate::transcript_peek::OPEN_DELAY);
    cx.run_until_parked();
    draw(cx);
    let card = cx.debug_bounds("transcript-peek").expect("peek opens");
    assert!(card.top() >= pill.bottom(), "{card:?} below {pill:?}");
    for line in 2..=9 {
        let selector = format!("transcript-peek-line-{line}").leak();
        assert!(cx.debug_bounds(selector).is_some(), "line {line}");
    }
    assert!(cx.debug_bounds("transcript-peek-line-10").is_none());
    cx.simulate_mouse_move(point(px(5.), px(650.)), None, gpui::Modifiers::default());
    cx.executor()
        .advance_clock(crate::transcript_peek::OPEN_DELAY);
    cx.run_until_parked();
    draw(cx);
    assert!(
        cx.debug_bounds("transcript-peek").is_none(),
        "closes on leave"
    );
}

/// A row in a transcript that ends above the window's bottom, as the list
/// ends above the composer.
struct ClippedRow(Rc<RefCell<RowState>>, Rc<std::cell::Cell<f32>>);
impl Render for ClippedRow {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            div()
                .w(px(600.))
                .h(px(self.1.get()))
                .overflow_hidden()
                .child(RetainedRow {
                    state: self.0.clone(),
                    index: 0,
                    painted: Default::default(),
                }),
        )
    }
}

#[gpui::test]
fn a_peek_near_the_transcripts_end_opens_above_its_pill(cx: &mut TestAppContext) {
    let text = format!("{}See `src/a.rs:5` now.", "A paragraph.\n\n".repeat(8));
    let mut state = RowState::new(Row::Message {
        id: "pill".into(),
        role: "assistant".into(),
        author: None,
        nodes: crate::text::markdown(&text),
    });
    let peeks = crate::transcript_peek::Peeks::default();
    let file: String = (1..=20).map(|n| format!("line {n}\n")).collect();
    peeks.remember("/repo/src/a.rs", &file);
    state.file_root = Some("/repo".into());
    state.peeks = Some(peeks);
    let state = Rc::new(RefCell::new(state));
    let height = Rc::new(std::cell::Cell::new(1000.));
    let (_, cx) = cx.add_window_view(|_, _| ClippedRow(state.clone(), height.clone()));
    cx.simulate_resize(size(px(900.), px(1000.)));
    let draw = |cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        })
    };
    let open = |cx: &mut gpui::VisualTestContext| {
        let pill = cx.debug_bounds("transcript-link-0-0").expect("file pill");
        cx.simulate_mouse_move(pill.center(), None, gpui::Modifiers::default());
        cx.executor()
            .advance_clock(crate::transcript_peek::OPEN_DELAY * 2);
        cx.run_until_parked();
        draw(cx);
        let card = cx.debug_bounds("transcript-peek").expect("peek opens");
        (pill, card)
    };
    draw(cx);
    let (pill, card) = open(cx);
    assert!(card.top() > pill.bottom(), "room below: {card:?} {pill:?}");
    assert!(card.size.height > px(150.), "eight lines: {card:?}");
    // The transcript now ends a little under the pill, as at the composer.
    cx.simulate_mouse_move(point(px(890.), px(990.)), None, gpui::Modifiers::default());
    cx.executor()
        .advance_clock(crate::transcript_peek::OPEN_DELAY * 2);
    cx.run_until_parked();
    height.set(f32::from(pill.bottom()) + 40.);
    draw(cx);
    assert!(cx.debug_bounds("transcript-peek").is_none());
    let (pill, card) = open(cx);
    assert!(
        card.bottom() < pill.top(),
        "flipped above: {card:?} {pill:?}"
    );
    assert!(card.top() >= px(0.), "{card:?}");
    assert!(card.right() <= px(600.), "inside across: {card:?}");
    for line in 2..=9 {
        let selector = format!("transcript-peek-line-{line}").leak();
        let row = cx.debug_bounds(selector).expect("every line");
        assert!(row.bottom() <= pill.top(), "line {line} clear of the pill");
    }
}
