//! Prompt navigation through painted chat and saved worker/reviewer transcripts.
use super::*;
use crate::pane::Pane;
use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

thread_local! {
    static PREVIEW: RefCell<Option<(String, String)>> = const { RefCell::new(None) };
}
// Observe the strings passed to the actual card, after a real hover/focus event.
pub(crate) fn record_preview(title: &str, answer: &str) {
    PREVIEW.with(|p| *p.borrow_mut() = Some((title.into(), answer.into())));
}
fn paint(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.refresh();
        w.draw(cx).clear();
    });
}
fn history(prefix: &str, count: usize) -> crate::model::History {
    let mut entries = Vec::new();
    for i in 0..count {
        entries.push(json!({"id":format!("{prefix}-p{i}"),"role":"user","text":format!("Review **prompt {i}**\nnext line {}", "long title ".repeat(70)),"packetHeader":{"enabled":i==0}}));
        entries.push(json!({"id":format!("{prefix}-note{i}"),"role":"assistant","text":"Early commentary, not the final answer."}));
        entries.push(json!({"id":format!("{prefix}-a{i}"),"role":"assistant","text":format!("**Final answer {i}** with useful detail.\n\n{}", "More answer detail.\n\n".repeat(40))}));
    }
    serde_json::from_value(
        json!({"sessionKey":format!("codex-owned:{prefix}"),"transcript":entries}),
    )
    .unwrap()
}
fn pane(prefix: &str, count: usize) -> Pane {
    let mut pane = Pane::new(Some(format!("codex-owned:{prefix}")));
    pane.install_saved(history(prefix, count));
    pane.navigate(false);
    pane
}
struct Reading(Pane, Option<Pane>);
impl Render for Reading {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(1000.))
            .h(px(400.))
            .flex()
            .child(
                div()
                    .w(px(490.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(self.0.content()),
            )
            .children(self.1.as_ref().map(|p| {
                div()
                    .w(px(490.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(p.content())
            }))
    }
}
fn row(pane: &Pane, id: &str) -> usize {
    pane.rows
        .iter()
        .position(|r| r.borrow().row.id() == id)
        .unwrap()
}
fn at_prompt(view: &Entity<Reading>, id: &str, cx: &mut VisualTestContext) {
    view.read_with(cx, |v, _| {
        let index = row(&v.0, id);
        assert_eq!(v.0.list.logical_scroll_top().item_ix, index);
        assert_eq!(v.0.list.logical_scroll_top().offset_in_item, px(0.));
        assert!(
            v.0.rows[index]
                .borrow()
                .painted_geometry
                .borrow()
                .row
                .origin
                .y
                .abs()
                < px(1.)
        );
    });
}
#[gpui::test]
fn tick_count_tracks_prompts_and_hides_short_transcripts(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane("count", 1), None));
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-tick-count-p0").is_none());
    view.update(cx, |v, cx| {
        v.0.install_saved(history("count", 3));
        cx.notify();
    });
    paint(cx);
    for selector in [
        "prompt-nav-tick-count-p0",
        "prompt-nav-tick-count-p1",
        "prompt-nav-tick-count-p2",
    ] {
        assert!(
            cx.debug_bounds(selector).is_some(),
            "one tick per prompt, including the packet header"
        );
    }
    assert!(cx.debug_bounds("prompt-nav-tick-count-p3").is_none());
}
#[gpui::test]
fn wheel_scrolling_marks_the_prompt_in_view(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane("scroll", 3), None));
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-current-scroll-p0").is_some());
    for _ in 0..8 {
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: point(px(300.), px(200.)),
            delta: gpui::ScrollDelta::Pixels(point(px(0.), px(-400.))),
            ..Default::default()
        });
        paint(cx);
    }
    let current = view.read_with(cx, |v, _| {
        let top = v.0.list.logical_scroll_top().item_ix;
        (0..3)
            .rev()
            .find(|i| row(&v.0, &format!("scroll-p{i}")) <= top)
            .unwrap()
    });
    assert!(current > 0, "the wheel actually moved to a later turn");
    assert!(
        cx.debug_bounds(
            [
                "prompt-nav-current-scroll-p0",
                "prompt-nav-current-scroll-p1",
                "prompt-nav-current-scroll-p2"
            ][current]
        )
        .is_some()
    );
    assert!(cx.debug_bounds("prompt-nav-current-scroll-p0").is_none());
}
#[gpui::test]
fn hover_and_keyboard_focus_show_compact_prompt_and_final_answer(cx: &mut TestAppContext) {
    let _ = PREVIEW.with(|p| p.borrow_mut().take());
    let (_view, cx) = cx.add_window_view(|_, _| Reading(pane("preview", 3), None));
    paint(cx);
    let tick = cx
        .debug_bounds("prompt-nav-tick-preview-p1")
        .expect("a native prompt tick");
    cx.simulate_mouse_move(tick.center(), None, Modifiers::default());
    paint(cx);
    let (title, answer) = PREVIEW
        .with(|p| p.borrow().clone())
        .expect("the real preview card is rendered");
    assert!(title.starts_with("Review prompt 1 next line "));
    assert!(!title.contains('\n'));
    assert!(
        title.ends_with('…'),
        "bounded long titles retain an ellipsis"
    );
    assert!(answer.starts_with("Final answer 1 with useful detail."));
    assert!(!answer.contains("Early commentary"));
    let title_bounds = cx.debug_bounds("prompt-nav-preview-title").unwrap();
    let answer_bounds = cx.debug_bounds("prompt-nav-preview-answer").unwrap();
    assert!(title_bounds.size.height >= px(17.) && title_bounds.size.height <= px(19.));
    assert!(answer_bounds.size.height >= px(18.) && answer_bounds.size.height <= px(36.));
    assert!(cx.debug_bounds("prompt-nav-preview").unwrap().size.height <= px(80.));
    cx.simulate_click(tick.center(), Modifiers::default());
    cx.simulate_mouse_move(point(px(300.), px(350.)), None, Modifiers::default());
    cx.simulate_keystrokes("home");
    paint(cx);
    assert!(
        PREVIEW.with(|p| p
            .borrow()
            .as_ref()
            .unwrap()
            .0
            .starts_with("Review prompt 0")),
        "keyboard focus has the same preview"
    );
}
#[gpui::test]
fn click_and_enter_jump_instantly_without_scrolling_another_pane(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane("jump", 3), Some(pane("other", 3))));
    paint(cx);
    let other = view.read_with(cx, |v, _| v.1.as_ref().unwrap().list.logical_scroll_top());
    let tick = cx
        .debug_bounds("prompt-nav-tick-jump-p1")
        .expect("a native prompt tick");
    cx.simulate_click(tick.center(), Modifiers::default());
    paint(cx);
    at_prompt(&view, "jump-p1", cx);
    cx.simulate_keystrokes("end enter");
    paint(cx);
    at_prompt(&view, "jump-p2", cx);
    cx.simulate_keystrokes("up enter");
    paint(cx);
    at_prompt(&view, "jump-p1", cx);
    view.read_with(cx, |v, _| {
        let now = v.1.as_ref().unwrap().list.logical_scroll_top();
        assert_eq!(
            (now.item_ix, now.offset_in_item),
            (other.item_ix, other.offset_in_item)
        );
    });
}
#[gpui::test]
fn chat_keyboard_jump_cancels_following_the_live_turn(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:1", None).unwrap();
    let (view, cx) = cx.add_window_view(|w, cx| Surface::new(client, w, cx));
    view.update(cx, |s, cx| {
        let mut h = history("chat", 3);
        h.session_key = "llm-chat:navigator".into();
        for entry in &mut h.transcript {
            entry.text = if entry.role == "user" {
                "Short question"
            } else {
                "Short answer"
            }
            .into();
        }
        let transcript = Transcript::new(h);
        let rows = transcript.rows.clone();
        s.transcript = Some(transcript);
        s.install_rows(rows, cx);
        s.following = Some(0);
        s.pinned = true;
        cx.notify();
    });
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-tick-chat-p0").is_some());
    view.read_with(cx, |s, _| {
        assert!(s.following.is_some());
        assert!(s.pinned);
    });
    cx.simulate_keystrokes("tab end enter");
    paint(cx);
    view.read_with(cx, |s, _| {
        assert!(s.following.is_none());
        assert!(!s.pinned);
        assert_eq!(
            s.list.logical_scroll_top().item_ix,
            s.rows
                .iter()
                .position(|r| r.borrow().row.id() == "chat-p2")
                .unwrap()
        );
        assert_eq!(s.list.logical_scroll_top().offset_in_item, px(0.));
    });
}

#[gpui::test]
fn a_short_final_turn_can_put_its_prompt_at_the_top(cx: &mut TestAppContext) {
    let mut history = history("short", 3);
    for entry in &mut history.transcript {
        entry.text = if entry.role == "user" {
            "Short question"
        } else {
            "Short answer"
        }
        .into();
    }
    let mut pane = Pane::new(Some("codex-owned:short".into()));
    pane.install_saved(history);
    pane.navigate(false);
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane, None));
    paint(cx);
    let original_end = view.read_with(cx, |v, _| v.0.list.max_offset_for_scrollbar().height);
    let tick = cx
        .debug_bounds("prompt-nav-tick-short-p2")
        .expect("the last prompt's tick");
    cx.simulate_click(tick.center(), Modifiers::default());
    paint(cx);
    at_prompt(&view, "short-p2", cx);
    view.update(cx, |v, cx| {
        v.0.navigate(true);
        cx.notify();
    });
    paint(cx);
    assert_eq!(
        view.read_with(cx, |v, _| v.0.list.max_offset_for_scrollbar().height),
        original_end,
        "returning to the end restores normal transcript spacing"
    );
}
