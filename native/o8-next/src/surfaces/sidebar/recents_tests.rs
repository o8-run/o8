//! Age groups and scrolling through the rendered shell and production records.
use super::*;

#[gpui::test]
fn sidebar_recents_groups_times_more_and_keyboard(cx: &mut TestAppContext) {
    let fixture = Fixture::with_options(&["--sidebar", "--sidebar-markers"]);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    for index in 0..20 {
        let id = format!("thoughts-sidebar-{index:04}");
        let record: Value = fixture
            .client
            .get("/api/v2/chat-history", &[("tabId", &id)])
            .unwrap();
        let age = if index < 16 {
            14 * 60_000
        } else if index < 18 {
            2 * 86_400_000
        } else {
            10 * 86_400_000
        };
        fixture.client.project_request("POST", "/api/v2/chat-history", &json!({"tabId":id,"repoPath":record["repoPath"],
            "messages":[{"id":format!("recent-{index}"),"role":"assistant","content":"Recent fixture", "timestamp":now-age}]})).unwrap();
    }
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("recents.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    let rows = native_rows(&shell, &visual);
    let labels: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["kind"] == "section")
        .map(|r| r["title"].as_str().unwrap())
        .collect();
    assert!(
        labels.starts_with(&["Recents", "Today", "Previous 7 days", "Previous 30 days"]),
        "Recents must use desktop age groups rather than workspace/status shelves: {labels:?}"
    );
    assert!(
        rows.as_array().unwrap().iter().any(|r| r["age"] == "14m"),
        "visible rows must include compact relative ages"
    );
    let marker = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "thoughts-sidebar-0019")
        .unwrap();
    assert_eq!(marker["branch"], true);
    assert_eq!(marker["attention"], true);
    let more = rows
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["kind"] == "more" && r["status"] == "Today")
        .expect("Today group must disclose its remaining rows");
    assert_eq!(rows[more]["title"], "Show 5 more");
    click(
        &mut visual,
        Box::leak(format!("thread-row-{more}").into_boxed_str()),
    );
    draw(&mut visual);
    assert_eq!(
        native_rows(&shell, &visual)
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("thoughts-sidebar-00")
                    && id[18..].parse::<usize>().unwrap_or(99) < 16))
            .count(),
        16
    );
    click(&mut visual, "thread-search");
    visual.simulate_keystrokes("escape end");
    settle(&shell, &mut visual);
    let sidebar = shell.read_with(&visual, |s, _| {
        s.surfaces.sidebar.view.as_ref().unwrap().clone()
    });
    let choice = sidebar.read_with(&visual, |s, _| {
        s.diagnostic()["choice"]["id"].as_str().unwrap().to_owned()
    });
    let index = sidebar.read_with(&visual, |s, _| {
        s.rows
            .iter()
            .position(|r| r.id.as_ref() == Some(&choice))
            .unwrap()
    });
    assert!(
        visual
            .debug_bounds(Box::leak(format!("thread-row-{index}").into_boxed_str()))
            .is_some(),
        "keyboard choice must remain materialized in the viewport"
    );
    visual.simulate_keystrokes("enter");
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .selected
            .as_ref()
            == Some(&choice)
    });
}

pub(super) fn native_rows(shell: &Entity<Shell>, cx: &VisualTestContext) -> Value {
    shell.read_with(cx, |s, cx| {
        serde_json::to_value(&*s.surfaces.sidebar.view.as_ref().unwrap().read(cx).rows).unwrap()
    })
}

#[gpui::test]
fn sidebar_recents_twelfth_keyboard_row_survives_live_cutoff(cx: &mut TestAppContext) {
    let fixture = Fixture::with_options(&["--sidebar"]);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    for index in 0..16 {
        let id = format!("thoughts-sidebar-{index:04}");
        let record: Value = fixture
            .client
            .get("/api/v2/chat-history", &[("tabId", &id)])
            .unwrap();
        fixture.client.project_request("POST", "/api/v2/chat-history", &json!({
            "tabId":id,"repoPath":record["repoPath"],"messages":[{
                "id":format!("cutoff-{index}"),"role":"assistant","content":"Cutoff fixture",
                "timestamp":now - 1000 * (index + 1)
            }]
        })).unwrap();
    }
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("cutoff.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    visual.simulate_keystrokes("f8 home");
    for _ in 0..11 {
        visual.simulate_keystrokes("down");
    }
    draw(&mut visual);
    let sidebar = shell.read_with(&visual, |s, _| {
        s.surfaces.sidebar.view.as_ref().unwrap().clone()
    });
    let focused = sidebar.read_with(&visual, |s, _| {
        s.diagnostic()["choice"]["id"].as_str().unwrap().to_owned()
    });
    let rows = native_rows(&shell, &visual);
    assert_eq!(
        rows[13]["id"], focused,
        "keyboard must focus the twelfth row"
    );
    assert_eq!(
        rows[14]["kind"], "more",
        "the group must still be collapsed"
    );
    let incoming = "thoughts-sidebar-0015";
    assert!(!rows.as_array().unwrap().iter().any(|r| r["id"] == incoming));
    let before = sidebar.read_with(&visual, |s, _| {
        s.sessions
            .iter()
            .find(|s| s.id == incoming)
            .unwrap()
            .last_message_at
            .clone()
    });
    let record: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", incoming)])
        .unwrap();
    fixture
        .client
        .project_request(
            "POST",
            "/api/v2/chat-history",
            &json!({
                "tabId":incoming,"repoPath":record["repoPath"],"messages":[{
                    "id":"cutoff-live-message","role":"assistant","content":"Newer message",
                    "timestamp":now + 1000
                }]
            }),
        )
        .unwrap();
    wait_for(&shell, &mut visual, |s, cx| {
        let list = s.surfaces.sidebar.view.as_ref().unwrap().read(cx);
        list.sessions
            .iter()
            .any(|s| s.id == incoming && s.last_message_at != before)
    });
    let choice_after_update =
        sidebar.read_with(&visual, |s, _| s.diagnostic()["choice"]["id"].clone());
    visual.simulate_keystrokes("enter");
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .selected
            .is_some()
            && s.active()
                .and_then(|t| s.content.get(&s.key(&t)))
                .is_some_and(|c| c.ready(cx))
    });
    assert_eq!(
        active_id(&shell, &mut visual),
        focused,
        "Enter after a live cutoff must open the thread the user keyboard-focused; choice after update: {choice_after_update}"
    );
    assert_eq!(choice_after_update, focused);
    let rows = native_rows(&shell, &visual);
    assert_eq!(
        rows[14]["id"], focused,
        "the focused thirteenth row must be revealed"
    );
    let bounds = visual.debug_bounds("thread-row-14").unwrap();
    assert!(
        visual
            .debug_bounds("thread-list")
            .unwrap()
            .intersects(&bounds),
        "focused row must stay in view"
    );
}
