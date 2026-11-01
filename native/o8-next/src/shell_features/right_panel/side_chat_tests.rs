use super::*;
use crate::shell::test_support::open;
use crate::shell::test_support::*;

fn click(v: &mut VisualTestContext, id: &'static str) {
    draw(v);
    let b = v.debug_bounds(id).unwrap_or_else(|| panic!("Missing {id}"));
    v.simulate_click(b.center(), gpui::Modifiers::default());
    v.run_until_parked();
    draw(v);
}
fn side(s: &Entity<Shell>, v: &mut VisualTestContext) -> Option<Entity<crate::ui::Surface>> {
    for _ in 0..20 {
        s.update_in(v, |s, w, cx| s.tick(true, w, cx));
        v.run_until_parked();
        draw(v);
        let view = s.read_with(v, |s, _| match s.content.get(&key(s, Tool::SideChat)) {
            Some(Content::Session(view)) => Some(view.clone()),
            _ => None,
        });
        if view.as_ref().is_some_and(|view| {
            view.read_with(v, |view, cx| view.shell_issue_state(cx)["ready"] == true)
        }) {
            return view;
        }
    }
    None
}

#[gpui::test]
fn side_chat_retries_sends_its_own_messages_and_restores_its_thread(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--side-chat");
    let mut state = crate::shell_state::State::default();
    state.bounds = [0., 0., 1680., 1050.];
    state.right_panel.visible = true;
    let file = f.root.join("side-chat.json");
    let (s, mut v) = open(f.client.clone(), file.clone(), state, cx);
    v.simulate_resize(gpui::size(px(1680.), px(1050.)));
    ready(&s, &mut v);
    let (main_tab, main) = s.read_with(&v, |s, _| {
        let tab = s.active().unwrap();
        let Content::Session(view) = &s.content[&s.key(&tab)] else {
            panic!("main chat")
        };
        (tab, view.clone())
    });
    main.update_in(&mut v, |main, w, cx| main.shell_focus(true, w, cx));
    v.simulate_input("Main draft stays here");
    let _: Value = f
        .client
        .get("/api/side-chat-fixture", &[("mode", "fail")])
        .unwrap();
    click(&mut v, "panel-launcher-more");
    click(&mut v, "panel-tool-side chat");
    s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
    v.run_until_parked();
    draw(&mut v);
    assert!(v.debug_bounds("side-chat-intro").is_some());
    assert!(v.debug_bounds("side-chat-retry").is_some());
    let _: Value = f
        .client
        .get("/api/side-chat-fixture", &[("mode", "ready")])
        .unwrap();
    click(&mut v, "side-chat-retry");
    let chat = side(&s, &mut v).expect("side chat must load its native conversation");
    let id = chat.read_with(&v, |chat, _| chat.shown_thread().unwrap());
    assert!(id.starts_with("thoughts-side-chat-"));
    assert_ne!(
        Some(id.clone()),
        main.read_with(&v, |main, _| main.shown_thread())
    );
    assert_eq!(s.read_with(&v, |s, _| s.active()), Some(main_tab.clone()));
    v.simulate_input("Side question only");
    assert_eq!(
        chat.read_with(&v, |chat, cx| chat.shell_issue_state(cx)["draft"].clone()),
        "Side question only"
    );
    v.simulate_keystrokes("enter");
    v.run_until_parked();
    draw(&mut v);
    let snapshot: Value = f.client.get("/api/side-chat-fixture", &[]).unwrap();
    assert!(
        snapshot["sends"]
            .as_array()
            .unwrap()
            .iter()
            .any(|body| body["threadId"] == id && body["payload"]["text"] == "Side question only"),
        "the native composer must send to the side thread: {snapshot}"
    );
    assert!(
        snapshot["histories"][&id]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "user"
                && m["content"]
                    .as_str()
                    .is_some_and(|text| text.contains("Side question only"))),
        "the operator message must be persisted in its own history: {snapshot}"
    );
    assert_eq!(
        main.read_with(&v, |main, cx| main.shell_issue_state(cx)["draft"].clone()),
        "Main draft stays here"
    );
    std::thread::sleep(std::time::Duration::from_millis(300));
    click(&mut v, "header-right-panel");
    assert!(!s.read_with(&v, |s, _| s.state.right_panel.visible));
    std::thread::sleep(std::time::Duration::from_millis(300));
    click(&mut v, "header-right-panel");
    assert!(s.read_with(&v, |s, _| s.state.right_panel.visible));
    assert_eq!(
        side(&s, &mut v)
            .unwrap()
            .read_with(&v, |chat, _| chat.shown_thread()),
        Some(id.clone())
    );
    let saved = crate::shell_state::State::load(&file).unwrap();
    assert_eq!(
        saved.right_panel.side_chats[saved.selected.as_ref().unwrap()],
        id
    );
    let (reopened, mut v2) = open(f.client.clone(), f.root.join("reopened.json"), saved, cx);
    v2.simulate_resize(gpui::size(px(1680.), px(1050.)));
    ready(&reopened, &mut v2);
    let restored = side(&reopened, &mut v2).unwrap_or_else(|| panic!("Restored side chat unavailable: {}", reopened.read_with(&v2, |s, cx| json!({"workspace":s.state.selected,"panel":s.state.right_panel.primary,"visible":s.state.right_panel.visible,"ids":s.sessions.iter().map(|session| &session.id).collect::<Vec<_>>(),"content":s.content.keys().collect::<Vec<_>>(),"state":s.content.get(&key(s,Tool::SideChat)).and_then(|content| match content {Content::Session(view)=>Some(view.read(cx).shell_issue_state(cx)),_=>None})}))));
    assert_eq!(
        restored.read_with(&v2, |chat, _| chat.shown_thread()),
        Some(id)
    );
}
