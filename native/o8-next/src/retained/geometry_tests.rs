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
        nodes: vec![],
    })));
    let (_, cx) = cx.add_window_view(|_, _| TranscriptRow(state.clone()));
    cx.simulate_resize(size(px(1680.), px(1050.)));
    for (name, nodes) in cases {
        *state.borrow_mut() = RowState::new(Row::Message {
            id: "user-rich".into(),
            role: "user".into(),
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
