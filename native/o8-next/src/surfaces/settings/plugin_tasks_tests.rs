use super::*;
use crate::shell::settings::mcp::plugin_task_entry_tests::Peer;
use gpui::{Keystroke, TestAppContext};
use std::sync::atomic::Ordering;
fn escape() -> KeyDownEvent {
    KeyDownEvent {
        keystroke: Keystroke::parse("escape").unwrap(),
        is_held: false,
    }
}

#[gpui::test]
fn plugin_task_launch_failure_holds_the_exact_task_for_inspection(cx: &mut TestAppContext) {
    let peer = Peer::new(false);
    let (view, cx) = cx.add_window_view(|_, cx| Tasks::new(peer.client(), cx));
    cx.run_until_parked();
    let launch = cx.debug_bounds("plugin-task-launch").unwrap();
    let inspect = cx.debug_bounds("plugin-task-inspect").unwrap();
    assert_eq!(launch.top(), inspect.top());
    assert!(launch.size.width < gpui::px(220.));
    let requirements = cx.debug_bounds("plugin-task-requirements").unwrap();
    assert!(
        requirements.size.width < gpui::px(300.),
        "disclosure is content-width"
    );
    view.update(cx, |view, cx| {
        assert!(view.available(Action::Launch));
        assert!(!view.available(Action::Inspect));
        view.control(Action::Launch, cx);
        assert!(view.busy == Some(Action::Launch));
        let generation = view.generation;
        view.control(Action::Launch, cx);
        view.load(cx);
        assert_eq!(view.generation, generation, "busy prevents refresh");
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.message.as_deref(), Some(UNCERTAIN));
        assert!(
            !view.available(Action::Launch),
            "an uncertain launch is never retried"
        );
        assert!(view.available(Action::Inspect));
        assert!(view.available(Action::Stop));
        assert_eq!(
            view.draft().unwrap().contract.objective,
            "Read the fixture and report evidence."
        );
    });
    assert_eq!(
        *peer.posts.lock().unwrap(),
        vec![json!({"action":"launch","taskId":"task-fixture","contractHash":"a".repeat(64)})]
    );
    peer.mode.store(1, Ordering::SeqCst);
    view.update(cx, |view, cx| view.control(Action::Inspect, cx));
    cx.run_until_parked();
    assert_eq!(peer.posts.lock().unwrap().len(), 2);
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.draft().unwrap().execution.as_ref().unwrap().attempt_id,
            "attempt-fixture"
        )
    });
    view.update(cx, |view, cx| {
        view.expanded = true;
        cx.notify();
    });
    assert!(cx.debug_bounds("plugin-task-exact-requirements").is_some());
    cx.update(|window, cx| view.update(cx, |view, cx| assert!(view.key(&escape(), window, cx))));
    assert!(cx.debug_bounds("plugin-task-exact-requirements").is_none());
}

#[gpui::test]
fn plugin_task_inspection_requires_the_current_sign_in_and_bound_receipt(cx: &mut TestAppContext) {
    let peer = Peer::new(true);
    peer.data.lock().unwrap()["drafts"][0]["sessionCurrent"] = json!(false);
    let (view, cx) = cx.add_window_view(|_, cx| Tasks::new(peer.client(), cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        assert!(!view.available(Action::Launch));
        assert!(!view.available(Action::Inspect));
        assert!(view.available(Action::Stop));
        view.control(Action::Inspect, cx);
    });
    assert!(peer.posts.lock().unwrap().is_empty());
    peer.data.lock().unwrap()["drafts"][0]["sessionCurrent"] = json!(true);
    view.update(cx, |view, cx| view.load(cx));
    cx.run_until_parked();
    peer.mode.store(2, Ordering::SeqCst);
    view.update(cx, |view, cx| view.control(Action::Inspect, cx));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.message.as_deref(), Some(UNCERTAIN));
        assert_eq!(
            view.draft()
                .unwrap()
                .execution
                .as_ref()
                .unwrap()
                .contract_hash,
            "a".repeat(64)
        );
        assert!(
            view.available(Action::Inspect),
            "failed inspection can be retried"
        );
    });
    peer.data.lock().unwrap()["accountId"] = json!("another-account");
    peer.data.lock().unwrap()["drafts"] = json!([]);
    view.update(cx, |view, cx| view.load(cx));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(
            view.stop_handle.is_none(),
            "an account switch drops the previous safety handle"
        );
        assert!(!view.available(Action::Stop));
    });
}

#[gpui::test]
fn plugin_task_stop_confirmation_survives_failure_and_sign_out(cx: &mut TestAppContext) {
    let peer = Peer::new(true);
    let (view, cx) = cx.add_window_view(|_, cx| Tasks::new(peer.client(), cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        view.control(Action::Stop, cx);
        view.confirm(true, cx);
    });
    assert!(peer.posts.lock().unwrap().is_empty());
    assert!(cx.debug_bounds("plugin-task-stop-confirm").is_some());
    assert!(cx.debug_bounds("plugin-task-stop-cancel").is_some());
    cx.update(|window, cx| view.update(cx, |view, cx| assert!(view.key(&escape(), window, cx))));
    assert!(cx.debug_bounds("plugin-task-stop-confirm").is_none());
    view.update(cx, |view, cx| {
        view.confirm(true, cx);
        view.confirm(false, cx);
        assert!(!view.confirming);
        view.confirm(true, cx);
        view.control(Action::Stop, cx);
        view.control(Action::Stop, cx);
        view.confirm(false, cx);
        assert!(view.confirming, "busy blocks cancellation");
    });
    view.update_in(cx, |view, window, cx| {
        assert!(view.key(&escape(), window, cx));
        assert!(
            view.confirming,
            "busy Escape leaves the request confirmation intact"
        );
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.confirming);
        assert_eq!(view.message.as_deref(), Some(UNCERTAIN));
        assert!(view.available(Action::Stop));
    });
    peer.deny_load.store(true, Ordering::SeqCst);
    view.update(cx, |view, cx| view.load(cx));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.account.is_none() && view.drafts.is_empty());
        assert!(
            view.confirming && view.available(Action::Stop),
            "sign-out cannot remove safety stop"
        );
    });
    peer.mode.store(1, Ordering::SeqCst);
    view.update(cx, |view, cx| view.control(Action::Stop, cx));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.confirming);
        assert!(view.stop_target().is_none());
    });
    let posts = peer.posts.lock().unwrap();
    assert_eq!(posts.len(), 2);
    assert_eq!(
        posts[0], posts[1],
        "retry preserves the reviewed task and contract"
    );
    assert!(cx.debug_bounds("plugin-task-stop").is_none());
}
