//! Text entry into a cached view keeps its input handler (#5111). A frame drawn
//! while the platform still holds the handler used to reuse the view's paint
//! range against an input-handler list that no longer had that entry.
use gpui::{
    App, AppContext, Bounds, Context, Entity, FocusHandle, InputHandler, IntoElement, Pixels,
    Point, Render, Styled, TestAppContext, UTF16Selection, Window, canvas, div, prelude::*,
};
use std::ops::Range;

struct Field {
    text: String,
    focus: FocusHandle,
    /// Draw a frame from inside text entry, before the platform gets the
    /// handler back.
    nested: bool,
}

struct Handler(Entity<Field>);

impl InputHandler for Handler {
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        cx: &mut App,
    ) -> Option<UTF16Selection> {
        let end = self.0.read(cx).text.encode_utf16().count();
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }
    fn marked_text_range(&mut self, _: &mut Window, _: &mut App) -> Option<Range<usize>> {
        None
    }
    fn text_for_range(
        &mut self,
        _: Range<usize>,
        _: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut App,
    ) -> Option<String> {
        None
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut App,
    ) {
        // No notify: the view stays cached, so the frame reuses its paint.
        let nested = self.0.update(cx, |field, _| {
            field.text.push_str(text);
            field.nested
        });
        if nested {
            window.draw(cx).clear();
        }
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.replace_text_in_range(range, text, window, cx);
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut App) {}
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: &mut Window,
        _: &mut App,
    ) -> Option<Bounds<Pixels>> {
        None
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut App,
    ) -> Option<usize> {
        None
    }
}

impl Render for Field {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (focus, field) = (self.focus.clone(), cx.entity());
        div().size_full().track_focus(&self.focus).child(
            canvas(
                |_, _, _| {},
                move |_, _, window, cx| window.handle_input(&focus, Handler(field), cx),
            )
            .size_full(),
        )
    }
}

struct Root(Entity<Field>);

impl Render for Root {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            gpui::AnyView::from(self.0.clone())
                .cached(gpui::StyleRefinement::default().size_full()),
        )
    }
}

#[gpui::test]
fn cached_text_entry_keeps_its_handler_and_every_character(cx: &mut TestAppContext) {
    let (root, cx) = cx.add_window_view(|window, cx| {
        let field = cx.new(|cx| Field {
            text: String::new(),
            focus: cx.focus_handle(),
            nested: true,
        });
        window.focus(&field.read(cx).focus.clone());
        Root(field)
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    let field = root.read_with(cx, |root, _| root.0.clone());
    let typed: String = (0..200)
        .map(|i| char::from(b'a' + (i % 26) as u8))
        .collect();

    // Each keystroke draws a frame while the platform holds the handler.
    cx.simulate_input(&typed);
    assert_eq!(field.read_with(cx, |field, _| field.text.clone()), typed);

    // Ordinary frames between keystrokes keep the handler and every character.
    field.update(cx, |field, _| {
        field.text.clear();
        field.nested = false;
    });
    for ch in typed.chars() {
        cx.simulate_input(&ch.to_string());
        cx.update(|window, cx| window.draw(cx).clear());
    }
    assert_eq!(field.read_with(cx, |field, _| field.text.clone()), typed);
}
