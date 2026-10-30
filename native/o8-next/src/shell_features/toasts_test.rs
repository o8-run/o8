use super::*;
use crate::shell::test_support::*;
use gpui::{Modifiers, VisualTestContext};
use std::{cell::Cell, rc::Rc};
struct ToastTests;
register_shell_feature!(ToastTests);
impl ShellFeature for ToastTests {}
type TestAction = (String, Box<dyn FnOnce(&mut Window, &mut App)>);
fn setup(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("toasts.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    (fixture, shell, visual)
}
fn push(
    shell: &Entity<Shell>,
    v: &mut VisualTestContext,
    kind: &str,
    text: &str,
    detail: &str,
    actions: Vec<TestAction>,
    timeout: Option<Duration>,
) -> u64 {
    shell.update_in(v, |_, _, cx| {
        let kind = match kind {
            "error" => crate::shell::toasts::Kind::Error {
                detail: detail.to_owned().into(),
            },
            "confirm" => crate::shell::toasts::Kind::Confirm,
            "spawn" => crate::shell::toasts::Kind::SpawnError {
                detail: detail.to_owned().into(),
            },
            "chat" => crate::shell::toasts::Kind::Chat,
            "success" => crate::shell::toasts::Kind::Success,
            _ => crate::shell::toasts::Kind::Info,
        };
        crate::shell::toasts::show(
            kind,
            text.to_owned(),
            actions
                .into_iter()
                .map(|(label, callback)| crate::shell::toasts::Action::new(label, callback))
                .collect(),
            timeout,
            cx,
        )
    })
}
fn remove(shell: &Entity<Shell>, v: &mut VisualTestContext, id: u64) {
    shell.update_in(v, |_, _, cx| crate::shell::toasts::dismiss(id, cx));
}
fn advance(v: &mut VisualTestContext, millis: u64) {
    v.run_until_parked();
    v.cx.executor().advance_clock(Duration::from_millis(millis));
    v.run_until_parked();
    draw(v);
}
fn bounds(v: &mut VisualTestContext, id: &str) -> Bounds<gpui::Pixels> {
    draw(v);
    v.debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("Missing real shell toast {id}"))
}
fn exists(v: &mut VisualTestContext, id: &str) -> bool {
    draw(v);
    v.debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .is_some()
}
fn click(v: &mut VisualTestContext, id: &str) {
    let b = bounds(v, id);
    v.simulate_click(b.center(), Modifiers::default());
    draw(v);
}
#[gpui::test]
fn shell_toasts_appear_stack_and_dismiss(cx: &mut TestAppContext) {
    let (_f, shell, mut v) = setup(cx);
    let a = push(&shell, &mut v, "success", "Saved.", "", vec![], None);
    let b = push(&shell, &mut v, "info", "Second notice.", "", vec![], None);
    advance(&mut v, 250);
    let one = bounds(&mut v, &format!("toast-{a}"));
    let two = bounds(&mut v, &format!("toast-{b}"));
    assert_eq!(two.top() - one.bottom(), px(8.));
    assert_eq!(one.right(), two.right());
    assert_eq!(one.top(), px(52.));
    click(&mut v, &format!("toast-{a}-dismiss"));
    advance(&mut v, 200);
    assert!(!exists(&mut v, &format!("toast-{a}")));
    assert!(exists(&mut v, &format!("toast-{b}")));
}
#[gpui::test]
fn shell_toasts_confirmation_action_fires_once_and_dismisses(cx: &mut TestAppContext) {
    let (_f, shell, mut v) = setup(cx);
    let count = Rc::new(Cell::new(0));
    let calls = count.clone();
    let id = push(
        &shell,
        &mut v,
        "confirm",
        "Thread archived.",
        "",
        vec![(
            "Undo".into(),
            Box::new(move |_, _| calls.set(calls.get() + 1)),
        )],
        None,
    );
    advance(&mut v, 60_000);
    let target = bounds(&mut v, &format!("toast-{id}-action-0")).center();
    v.simulate_click(target, Modifiers::default());
    v.simulate_click(target, Modifiers::default());
    assert_eq!(count.get(), 1);
    advance(&mut v, 200);
    assert!(!exists(&mut v, &format!("toast-{id}")));
}
#[gpui::test]
fn shell_toasts_timeout_and_hover_pause_preserve_remaining_time(cx: &mut TestAppContext) {
    let (_f, shell, mut v) = setup(cx);
    let id = push(
        &shell,
        &mut v,
        "info",
        "Timed notice.",
        "",
        vec![],
        Some(Duration::from_secs(1)),
    );
    advance(&mut v, 350);
    let b = bounds(&mut v, &format!("toast-{id}"));
    v.simulate_mouse_move(b.center(), None, Modifiers::default());
    advance(&mut v, 5000);
    assert!(
        exists(&mut v, &format!("toast-{id}")),
        "hover must pause the original timeout"
    );
    v.simulate_mouse_move(point(px(100.), px(200.)), None, Modifiers::default());
    advance(&mut v, 600);
    assert!(
        exists(&mut v, &format!("toast-{id}")),
        "leaving keeps the remaining lifetime"
    );
    advance(&mut v, 100);
    advance(&mut v, 200);
    assert!(!exists(&mut v, &format!("toast-{id}")));
    let id = push(
        &shell,
        &mut v,
        "info",
        "No hover.",
        "",
        vec![],
        Some(Duration::from_millis(500)),
    );
    advance(&mut v, 550);
    advance(&mut v, 200);
    assert!(
        !exists(&mut v, &format!("toast-{id}")),
        "a non-hovered notice expires"
    );
}
#[gpui::test]
fn shell_toasts_error_detail_expands_and_collapses(cx: &mut TestAppContext) {
    let (_f, shell, mut v) = setup(cx);
    let id = push(
        &shell,
        &mut v,
        "error",
        "Could not start a thread.",
        "The local server refused the request.\nNo conversation was created.\nTry again after reconnecting.",
        vec![],
        None,
    );
    advance(&mut v, 250);
    let before = bounds(&mut v, &format!("toast-{id}"));
    assert!(!exists(&mut v, &format!("toast-{id}-detail")));
    click(&mut v, &format!("toast-{id}-detail-toggle"));
    bounds(&mut v, &format!("toast-{id}-detail"));
    assert!(bounds(&mut v, &format!("toast-{id}")).size.height > before.size.height);
    click(&mut v, &format!("toast-{id}-detail-toggle"));
    assert!(!exists(&mut v, &format!("toast-{id}-detail")));
}
#[gpui::test]
fn shell_toasts_placements_capacity_and_public_dismiss(cx: &mut TestAppContext) {
    let (_f, shell, mut v) = setup(cx);
    let spawn = push(
        &shell,
        &mut v,
        "spawn",
        "Spawn failed.",
        "Provider detail.",
        vec![],
        None,
    );
    let chat = push(&shell, &mut v, "chat", "Thread archived.", "", vec![], None);
    advance(&mut v, 250);
    let bottom = bounds(&mut v, &format!("toast-{spawn}"));
    let compact = bounds(&mut v, &format!("toast-{chat}"));
    assert!(bottom.top() > px(300.) && compact.top() > px(300.));
    assert!(
        compact.right() > bottom.right(),
        "chat is right-aligned, spawn error centered"
    );
    remove(&shell, &mut v, spawn);
    remove(&shell, &mut v, chat);
    advance(&mut v, 200);
    let mut ids = vec![];
    for _ in 0..6 {
        ids.push(push(&shell, &mut v, "info", "Notice.", "", vec![], None));
    }
    advance(&mut v, 250);
    assert!(!exists(&mut v, &format!("toast-{}", ids[0])));
    assert!(!exists(&mut v, &format!("toast-{}", ids[1])));
    for id in &ids[2..] {
        bounds(&mut v, &format!("toast-{id}"));
    }
}
#[gpui::test]
fn shell_toasts_existing_transient_callers_use_host_and_status_stays_inline(
    cx: &mut TestAppContext,
) {
    let (_f, shell, mut v) = setup(cx);
    shell.update_in(&mut v, |s, w, cx| {
        for surface in ["toast-missing-a", "toast-missing-b"] {
            s.ui_command(
                &serde_json::json!({"kind":"symon-ui","payload":{"data":{"surface":surface}}}),
                w,
                cx,
            );
        }
    });
    advance(&mut v, 250);
    bounds(&mut v, "toast-1");
    bounds(&mut v, "toast-2");
    assert!(
        shell.read_with(&v, |s, _| s.notice.is_empty()),
        "transient notices do not occupy the status line"
    );
    shell.update_in(&mut v, |s, _, cx| {
        s.notice = "Connecting to local o8 server…".into();
        cx.notify();
    });
    bounds(&mut v, "shell-status");
}
