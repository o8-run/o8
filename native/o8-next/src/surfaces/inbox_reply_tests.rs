use super::*;
use crate::shell::test_support::*;
fn click(v: &mut VisualTestContext, id: &str) {
    draw(v);
    let b = v
        .debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("Missing {id}"));
    v.simulate_click(b.center(), gpui::Modifiers::default());
    v.run_until_parked();
    draw(v);
}
fn active_chat(s: &Entity<Shell>, v: &VisualTestContext) -> Entity<crate::ui::Surface> {
    s.read_with(v, |s, _| {
        let tab = s.active().unwrap();
        match &s.content[&s.key(&tab)] {
            Content::Session(view) => view.clone(),
            _ => panic!("reply must open a conversation"),
        }
    })
}
#[gpui::test]
fn inbox_reply_and_approval_seed_the_matching_chat_without_sending(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--inbox --side-chat");
    let mut state = State::default();
    state.right_panel.visible = true;
    let (s, mut v) = open(f.client.clone(), f.root.join("reply.json"), state, cx);
    v.simulate_resize(gpui::size(px(1680.), px(1050.)));
    ready(&s, &mut v);
    let original = active_chat(&s, &v);
    original.update_in(&mut v, |view, w, cx| view.shell_focus(true, w, cx));
    v.simulate_input("Keep this draft.");
    click(&mut v, "panel-tool-inbox");
    v.run_until_parked();
    draw(&mut v);
    std::thread::sleep(std::time::Duration::from_millis(300));
    draw(&mut v);
    let inbox = inbox_panel(&s, &v);
    let card = inbox.read_with(&v, |i, _| i.cards[0][0].clone());
    click(&mut v, &format!("inbox-respond-{}", card.id));
    let chat = active_chat(&s, &v);
    let prompt = chat.read_with(&v, |view, cx| {
        view.shell_issue_state(cx)["draft"]
            .as_str()
            .unwrap()
            .to_string()
    });
    assert!(
        prompt.contains(&card.url)
            && prompt.contains(&card.title)
            && prompt.contains("Keep this draft.")
    );
    assert!(prompt.contains("wait for explicit approval before posting"));
    click(&mut v, &format!("inbox-respond-{}", card.id));
    assert_eq!(
        chat.read_with(&v, |view, cx| view.shell_issue_state(cx)["draft"].clone()),
        prompt,
        "opening the same item again must not duplicate its context"
    );
    click(&mut v, "inbox-view-approvals");
    let approval = inbox.read_with(&v, |inbox, _| {
        inbox.cards[2]
            .iter()
            .find(|card| card.status == "pending")
            .unwrap()
            .clone()
    });
    click(&mut v, &format!("inbox-respond-{}", approval.id));
    let approval_chat = active_chat(&s, &v);
    assert_eq!(
        approval_chat.read_with(&v, |view, _| view.shown_thread()),
        Some(approval.session.trim_start_matches("llm-chat:").to_string())
    );
    assert!(approval_chat.read_with(&v, |view, cx| {
        view.shell_issue_state(cx)["draft"]
            .as_str()
            .unwrap()
            .contains(&approval.title)
    }));
    let records: Value = f
        .client
        .get(
            "/api/panel/approvals",
            &[("status", "pending"), ("scope", "all")],
        )
        .unwrap();
    assert!(
        records["approvals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["id"] == approval.id && record["status"] == "pending"),
        "discussing must not decide an approval"
    );
    click(&mut v, "inbox-view-replies");
    let repo = card.repo_paths[0].clone();
    s.update(&mut v, |s, _| {
        s.sessions
            .retain(|session| session.repo_path.as_ref() != Some(&repo))
    });
    click(&mut v, &format!("inbox-respond-{}", card.id));
    for _ in 0..20 {
        s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
        v.run_until_parked();
        draw(&mut v);
        if active_chat(&s, &v).read_with(&v, |view, _| {
            view.shown_thread()
                .is_some_and(|id| id.starts_with("thoughts-next-"))
        }) {
            break;
        }
    }
    let created = active_chat(&s, &v);
    assert!(
        created.read_with(&v, |view, _| view
            .shown_thread()
            .unwrap()
            .starts_with("thoughts-next-")),
        "a workspace without an available chat must create one through the existing New chat path"
    );
    assert!(created.read_with(&v, |view, cx| {
        view.shell_issue_state(cx)["draft"]
            .as_str()
            .unwrap()
            .contains(&card.url)
    }));
    let snapshot: Value = f.client.get("/api/side-chat-fixture", &[]).unwrap();
    assert!(
        snapshot["sends"].as_array().unwrap().is_empty(),
        "handoffs must remain unsent"
    );
    assert!(original.read_with(&v, |view, cx| {
        view.shell_issue_state(cx)["draft"]
            .as_str()
            .unwrap()
            .contains("Keep this draft.")
    }));
}
