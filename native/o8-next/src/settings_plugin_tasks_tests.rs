//! The Settings capture handler must cancel a task confirmation before closing.
use super::*;
use crate::shell::settings::{mcp::plugin_task_entry_tests::Peer, plugin_tasks::Tasks};
use gpui::{KeyDownEvent, Keystroke, TestAppContext};
use std::{cell::Cell, rc::Rc};

#[gpui::test]
fn settings_plugin_task_escape_cancels_before_closing(cx: &mut TestAppContext) {
    let peer = Peer::new(true);
    let (settings, cx) = cx.add_window_view(|window, cx| {
        let tasks = cx.new(|cx| Tasks::new(peer.client(), cx));
        let mut settings = Settings::new(peer.client(), window, cx);
        settings.section = "mcp";
        settings.mcp = Some(tasks.clone().into());
        settings.plugin_tasks = Some(tasks);
        settings
    });
    let closed = Rc::new(Cell::new(0));
    let count = closed.clone();
    let _subscription = cx
        .update(|_, cx| cx.subscribe(&settings, move |_, _: &Close, _| count.set(count.get() + 1)));
    cx.run_until_parked();
    let tasks = settings.read_with(cx, |settings, _| settings.plugin_tasks.clone().unwrap());
    tasks.update(cx, |tasks, cx| tasks.confirm(true, cx));
    assert!(cx.debug_bounds("plugin-task-stop-confirm").is_some());
    let event = KeyDownEvent {
        keystroke: Keystroke::parse("escape").unwrap(),
        is_held: false,
    };
    settings.update_in(cx, |settings, window, cx| {
        settings.begin(
            Target::File("fixture-revision".into()),
            "fixture text",
            window,
            cx,
        );
        assert!(settings.editor.is_some());
        settings.key(&event, window, cx);
        assert!(
            settings.editor.is_none(),
            "the outer Settings editor cancels first"
        );
    });
    assert!(cx.debug_bounds("plugin-task-stop-confirm").is_some());
    assert_eq!(closed.get(), 0);
    settings.update(cx, |settings, cx| {
        settings.search.update(cx, |search, cx| {
            search.text = "held tasks".into();
            cx.notify();
        })
    });
    settings.update_in(cx, |settings, window, cx| settings.key(&event, window, cx));
    assert_eq!(closed.get(), 0);
    assert!(
        settings.read_with(cx, |settings, cx| settings.search.read(cx).text.is_empty()),
        "Escape clears the active search before touching its hidden task confirmation"
    );
    assert!(cx.debug_bounds("plugin-task-stop-confirm").is_some());
    settings.update_in(cx, |settings, window, cx| settings.key(&event, window, cx));
    assert!(cx.debug_bounds("plugin-task-stop-confirm").is_none());
    assert_eq!(
        closed.get(),
        0,
        "first Escape cancels the task confirmation"
    );
    settings.update_in(cx, |settings, window, cx| settings.key(&event, window, cx));
    assert_eq!(closed.get(), 1, "a later Escape still closes Settings");
}
