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
