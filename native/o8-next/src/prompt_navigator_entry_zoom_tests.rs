use super::*;

#[gpui::test]
fn keyboard_entry_previews_immediately_and_space_jumps(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:1", None).unwrap();
    let (view, cx) = cx.add_window_view(|w, cx| Surface::new(client, w, cx));
    view.update_in(cx, |s, w, cx| {
        let mut saved = history("focus-entry", 30);
        saved.session_key = "llm-chat:focus-entry".into();
        let transcript = Transcript::new(saved);
        let rows = transcript.rows.clone();
        s.transcript = Some(transcript);
        s.install_rows(rows, cx);
        s.navigate(false, cx);
        s.focus.focus(w);
        cx.notify();
    });
    paint(cx);
    cx.simulate_keystrokes("shift-tab");
    paint(cx);
    assert!(cx.update(|w, cx| view.read(cx).navigator.borrow().is_focused(w)));
    assert!(
        cx.debug_bounds("prompt-nav-preview").is_some(),
        "keyboard entry previews immediately, before any arrow key"
    );
    view.read_with(cx, |s, _| {
        assert!(
            s.navigator
                .borrow()
                .cached_preview()
                .unwrap()
                .0
                .starts_with("Review prompt 0")
        );
    });
    cx.simulate_keystrokes("end space");
    paint(cx);
    view.read_with(cx, |s, _| {
        let index = s
            .rows
            .iter()
            .position(|r| r.borrow().row.id() == "focus-entry-p29")
            .unwrap();
        assert_eq!(s.list.logical_scroll_top().item_ix, index);
        assert_eq!(s.list.logical_scroll_top().offset_in_item, px(0.));
    });
    assert!(cx.debug_bounds("prompt-nav-preview").is_none());
    cx.simulate_keystrokes("shift-tab home");
    paint(cx);
    cx.simulate_keystrokes("shift-tab");
    paint(cx);
    assert!(
        cx.debug_bounds("prompt-nav-preview").is_some(),
        "re-entry previews the selected tick after it leaves the visible rail page"
    );
    view.read_with(cx, |s, _| {
        let first = s
            .rows
            .iter()
            .position(|r| r.borrow().row.id() == "focus-entry-p0")
            .unwrap();
        assert_eq!(
            s.list.logical_scroll_top().item_ix,
            first,
            "focus previews without jumping the transcript"
        );
        assert!(
            s.navigator
                .borrow()
                .cached_preview()
                .unwrap()
                .0
                .starts_with("Review prompt 29")
        );
    });
}

struct ZoomReading(Pane);
impl Render for ZoomReading {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .pl(px(52.))
            .pt(px(40.))
            .child(
                div()
                    .w(px(280.))
                    .h(px(300.))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .child(self.0.content()),
            )
    }
}

#[gpui::test]
fn zoomed_ticks_keep_hit_targets_preview_bounds_and_jumps(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| ZoomReading(pane("zoom-nav", 3)));
    cx.simulate_resize(size(px(1000.), px(800.)));
    for zoom in [0.7, 1.4, 2.0] {
        cx.update(|w, cx| w.set_zoom(zoom, cx));
        view.update(cx, |v, cx| {
            v.0 = pane("zoom-nav", 3);
            cx.notify();
        });
        paint(cx);
        let tick = cx.debug_bounds("prompt-nav-tick-zoom-nav-p1").unwrap();
        let tolerance = cx.update(|w, _| px(1. / w.scale_factor() + 1e-3));
        assert!((tick.size.height - px(12.)).abs() <= tolerance);
        assert!((tick.size.width - px(24.)).abs() <= tolerance);
        // Test-platform input uses screen points; GPUI converts it to the
        // same zoomed layout units used by the rail's canvas and hit testing.
        let screen = tick.center().map(|v| v * zoom);
        cx.simulate_mouse_move(screen, None, Modifiers::default());
        paint(cx);
        let card = cx
            .debug_bounds("prompt-nav-preview")
            .expect("hover hits the tick at this zoom");
        assert!((card.left() - tick.left() - px(28.)).abs() <= tolerance);
        assert!((card.size.width - px(244.)).abs() <= tolerance);
        assert!(card.left() >= tick.right());
        assert!(card.right() <= px(332.) + tolerance);
        assert!(card.top() >= px(40.) && card.bottom() <= px(340.) + tolerance);
        assert!(
            cx.debug_bounds("prompt-nav-preview-title")
                .unwrap()
                .size
                .height
                <= px(18.) + tolerance
        );
        assert!(
            cx.debug_bounds("prompt-nav-preview-answer")
                .unwrap()
                .size
                .height
                <= px(36.) + tolerance
        );
        view.read_with(cx, |v, _| {
            let (title, answer) = v.0.navigator.borrow().cached_preview().unwrap();
            assert!(title.starts_with("Review prompt 1"));
            assert!(answer.starts_with("Final answer 1"));
        });
        cx.simulate_click(screen, Modifiers::default());
        paint(cx);
        let index = view.read_with(cx, |v, _| {
            let index = row(&v.0, "zoom-nav-p1");
            assert_eq!(v.0.list.logical_scroll_top().item_ix, index);
            assert_eq!(v.0.list.logical_scroll_top().offset_in_item, px(0.));
            index
        });
        let prompt = cx.debug_bounds(&format!("transcript-row-{index}")).unwrap();
        assert!((prompt.top() - px(40.)).abs() <= tolerance);
        assert!(cx.debug_bounds("prompt-nav-current-zoom-nav-p1").is_some());
        assert!(cx.debug_bounds("prompt-nav-preview").is_none());
    }
}

#[gpui::test]
fn native_tab_traversal_previews_and_escape_does_not_reopen(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane("native-focus", 3), None));
    paint(cx);
    let mut reached = false;
    // Reviewer panes use native tab-stop traversal rather than Surface's
    // custom composer/rail handler. Enter through that same window API.
    for _ in 0..32 {
        cx.update(|w, _| w.focus_next());
        paint(cx);
        if cx.update(|w, cx| view.read(cx).0.navigator.borrow().is_focused(w)) {
            reached = true;
            break;
        }
    }
    assert!(
        reached,
        "the rail is reachable through native Tab traversal"
    );
    assert!(cx.debug_bounds("prompt-nav-preview").is_some());
    cx.simulate_keystrokes("escape");
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-preview").is_none());
    for _ in 0..3 {
        paint(cx);
    }
    assert!(cx.update(|w, cx| view.read(cx).0.navigator.borrow().is_focused(w)));
    assert!(
        cx.debug_bounds("prompt-nav-preview").is_none(),
        "retained focus does not reopen a dismissed preview"
    );
}
