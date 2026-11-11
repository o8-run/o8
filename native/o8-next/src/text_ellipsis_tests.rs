//! Unwrapped text that asks for an ellipsis ends in one. GPUI measures such
//! text first with no width and again with the real one; the second measure
//! used to reuse the first size, so the full text was laid out and the parent
//! clipped it mid-letter.
use gpui::{
    Context, IntoElement, Render, StyledText, TestAppContext, TextLayout, Window, div, prelude::*,
    px,
};

const WIDTH: f32 = 220.;
const LONG: &str = "Review the pull request that folds a shelf while its open thread sits on it";

/// The two places a sidebar card puts one-line text.
#[derive(Clone, Copy)]
enum Shape {
    /// A block inside the card's column: the title.
    Column,
    /// A shrinking item of a row inside that column: the project line.
    Row,
}

struct Card {
    title: &'static str,
    shape: Shape,
    layout: Option<TextLayout>,
}

impl Render for Card {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let title = StyledText::new(self.title);
        self.layout = Some(title.layout().clone());
        let line = div()
            .whitespace_nowrap()
            .overflow_hidden()
            .text_ellipsis()
            .child(title);
        let column = div().flex().flex_col().flex_1().min_w_0();
        div().size_full().child(
            div().w(px(WIDTH)).flex().child(match self.shape {
                Shape::Column => column.child(div().h(px(16.)).child("o8")).child(line),
                Shape::Row => column.child(
                    div()
                        .flex()
                        .items_center()
                        .child(line.flex_1().min_w_0())
                        .child(div().flex_shrink_0().child("Done")),
                ),
            }),
        )
    }
}

fn drawn(title: &'static str, shape: Shape, cx: &mut TestAppContext) -> String {
    let (card, cx) = cx.add_window_view(|_, _| Card {
        title,
        shape,
        layout: None,
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    card.read_with(cx, |card, _| card.layout.as_ref().unwrap().text())
}

#[gpui::test]
fn a_long_one_line_title_in_a_column_ends_in_an_ellipsis(cx: &mut TestAppContext) {
    let text = drawn(LONG, Shape::Column, cx);
    assert!(
        text.ends_with('…') && text.len() < LONG.len(),
        "a title wider than its card must be shortened to an ellipsis: {text:?}"
    );
}

#[gpui::test]
fn a_long_one_line_label_in_a_row_ends_in_an_ellipsis(cx: &mut TestAppContext) {
    let text = drawn(LONG, Shape::Row, cx);
    assert!(
        text.ends_with('…') && text.len() < LONG.len(),
        "a label wider than its row must be shortened to an ellipsis: {text:?}"
    );
}

#[gpui::test]
fn text_that_fits_is_left_whole(cx: &mut TestAppContext) {
    assert_eq!(drawn("Short", Shape::Column, cx), "Short");
    assert_eq!(drawn("Short", Shape::Row, cx), "Short");
}
