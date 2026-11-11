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

/// A sidebar card's shape: a row whose column holds a one-line title.
struct Card {
    title: &'static str,
    layout: Option<TextLayout>,
}

impl Render for Card {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let title = StyledText::new(self.title);
        self.layout = Some(title.layout().clone());
        div().size_full().child(
            div().w(px(WIDTH)).flex().child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(div().h(px(16.)).child("o8"))
                    .child(
                        div()
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(title),
                    ),
            ),
        )
    }
}

fn drawn(title: &'static str, cx: &mut TestAppContext) -> TextLayout {
    let (card, cx) = cx.add_window_view(|_, _| Card {
        title,
        layout: None,
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    card.read_with(cx, |card, _| card.layout.clone().unwrap())
}

#[gpui::test]
fn a_long_one_line_title_in_a_column_ends_in_an_ellipsis(cx: &mut TestAppContext) {
    let layout = drawn(LONG, cx);
    let text = layout.text();
    assert!(
        text.ends_with('…'),
        "a title wider than its card must end in an ellipsis: {text:?}"
    );
    assert!(
        layout.bounds().size.width <= px(WIDTH),
        "the title must fit its card: {:?}",
        layout.bounds().size.width
    );
}

#[gpui::test]
fn a_title_that_fits_is_left_whole(cx: &mut TestAppContext) {
    assert_eq!(drawn("Short", cx).text(), "Short");
}
