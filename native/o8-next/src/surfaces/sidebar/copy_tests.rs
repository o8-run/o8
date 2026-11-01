//! Row menu Copy: the thread ID and its o8://thread link, each with a toast.
use super::*;

fn copy_through_row_menu(cx: &mut TestAppContext, selector: &'static str) -> (String, String) {
    let fixture = Fixture::with_sidebar(true);
    let id = "thoughts-sidebar-1999";
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("copy-row.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    let sidebar = shell.read_with(&visual, |s, _| {
        s.surfaces.sidebar.view.as_ref().unwrap().clone()
    });
    let index = sidebar.read_with(&visual, |s, _| {
        s.rows
            .iter()
            .position(|r| r.id.as_deref() == Some(id))
            .unwrap()
    });
    sidebar.update(&mut visual, |s, cx| {
        s.scroll.scroll_to_item_strict(index, ScrollStrategy::Top);
        cx.notify();
    });
    draw(&mut visual);
    let bounds = visual
        .debug_bounds(Box::leak(format!("thread-row-{index}").into_boxed_str()))
        .unwrap();
    visual.simulate_mouse_down(bounds.center(), gpui::MouseButton::Right, gpui::Modifiers::default());
    visual.simulate_mouse_up(bounds.center(), gpui::MouseButton::Right, gpui::Modifiers::default());
    draw(&mut visual);
    click(&mut visual, selector);
    draw(&mut visual);
    let copied = visual
        .read_from_clipboard()
        .and_then(|item| item.text())
        .unwrap_or_default();
    let toasts = visual.update(|_, cx| crate::shell::toasts::texts(cx)).join("|");
    assert!(
        visual.debug_bounds("sidebar-row-menu").is_none(),
        "Copy closes the row menu"
    );
    (copied, toasts)
}

#[gpui::test]
fn sidebar_row_menu_copies_the_thread_id(cx: &mut TestAppContext) {
    let (copied, toasts) = copy_through_row_menu(cx, "sidebar-row-copy-id");
    assert_eq!(copied, "thoughts-sidebar-1999");
    assert!(toasts.contains("Thread ID copied"), "{toasts}");
}

#[gpui::test]
fn sidebar_row_menu_copies_the_thread_link(cx: &mut TestAppContext) {
    let (copied, toasts) = copy_through_row_menu(cx, "sidebar-row-copy-link");
    assert_eq!(copied, "o8://thread/thoughts-sidebar-1999");
    assert!(toasts.contains("Thread link copied"), "{toasts}");
}
