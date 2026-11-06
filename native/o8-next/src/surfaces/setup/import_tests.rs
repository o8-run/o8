//! First launch offers existing Codex and Claude Code threads (#5260),
//! through the production discovered-session routes.
use super::click;
use crate::shell::test_support::*;
use crate::shell::*;

type Picked = (
    Option<&'static str>,
    Vec<(String, usize)>,
    usize,
    Option<String>,
);

fn state(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Picked {
    shell.read_with(cx, |s, cx| {
        let view = s
            .surfaces
            .setup
            .view
            .as_ref()
            .expect("setup is open")
            .read(cx);
        let (groups, selected, note) = view.import_state();
        (view.painted_page(), groups, selected, note)
    })
}
fn tap(cx: &mut VisualTestContext, selector: String) {
    click(cx, Box::leak(selector.into_boxed_str()));
}
fn imported(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> usize {
    shell.read_with(cx, |s, _| {
        s.sessions
            .iter()
            .filter(|session| session.id.starts_with("thoughts-import-"))
            .count()
    })
}

#[gpui::test]
fn setup_offers_discovered_threads_imports_a_selection_and_reruns_idempotently(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start_mode(false, "--onboarding --discovered-import");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("discovered-import.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);

    // First launch opens on the import step, nothing selected.
    let (page, groups, selected, _) = state(&shell, cx);
    assert_eq!(page, Some("import"), "{groups:?}");
    assert!(cx.debug_bounds("setup-import").is_some());
    let bulk = groups
        .iter()
        .position(|(path, n)| path.ends_with("/bulk-repo") && *n == 2048)
        .unwrap_or_else(|| panic!("2048 historical threads: {groups:?}"));
    let repo = groups
        .iter()
        .position(|(path, n)| !path.ends_with("/bulk-repo") && *n == 3)
        .unwrap_or_else(|| panic!("3 threads in the project: {groups:?}"));
    assert_eq!(selected, 0);

    click(cx, "setup-import-all");
    assert_eq!(state(&shell, cx).2, 2051);
    click(cx, "setup-import-none");
    assert_eq!(state(&shell, cx).2, 0);

    // A 2048-thread folder opens without selecting, and paints only the rows in view.
    assert!(
        cx.debug_bounds(Box::leak(
            format!("setup-import-thread-{bulk}-0").into_boxed_str()
        ))
        .is_none()
    );
    tap(cx, format!("setup-import-expand-{bulk}"));
    assert_eq!(state(&shell, cx).2, 0, "expanding does not select");
    assert!(
        cx.debug_bounds(Box::leak(
            format!("setup-import-thread-{bulk}-0").into_boxed_str()
        ))
        .is_some()
    );
    assert!(
        cx.debug_bounds(Box::leak(
            format!("setup-import-thread-{bulk}-2047").into_boxed_str()
        ))
        .is_none()
    );

    // The project's three threads, plus one historical thread whose session is gone.
    tap(cx, format!("setup-import-group-{repo}"));
    assert_eq!(state(&shell, cx).2, 3);
    tap(cx, format!("setup-import-thread-{bulk}-0"));
    assert_eq!(state(&shell, cx).2, 4);
    click(cx, "setup-import-confirm");
    let (page, _, _, note) = state(&shell, cx);
    assert_eq!(page, Some("projects"));
    assert_eq!(
        note.as_deref(),
        Some("Imported 3 threads. 1 could not be continued: their saved sessions are missing.")
    );
    assert!(cx.debug_bounds("setup-import-note").is_some());
    assert_eq!(
        imported(&shell, cx),
        3,
        "the shell lists the imported chats"
    );
    let pending: Value = fixture
        .client
        .get("/api/runtime/discovered-sessions", &[])
        .unwrap();
    let pending = pending["sessions"].as_array().unwrap();
    assert_eq!(pending.len(), 2048, "only the historical threads remain");
    for session in fixture.client.sessions().unwrap() {
        if session.id.starts_with("thoughts-import-") {
            let history: Value = fixture
                .client
                .get("/api/v2/chat-history", &[("tabId", session.id.as_str())])
                .unwrap();
            let ids = history["orchestratorSessionIds"].as_object().unwrap();
            assert_eq!(ids.len(), 1, "{history}");
            assert_eq!(history["messages"], json!([]), "importing sends nothing");
        }
    }

    // Opening Setup again offers only what is left; importing it again is a no-op.
    assert!(cx.debug_bounds("setup-import-open").is_some());
    shell.update(cx, |s, cx| {
        s.surfaces.setup.view = None;
        s.open_setup(cx);
    });
    cx.run_until_parked();
    draw(cx);
    let (page, groups, _, _) = state(&shell, cx);
    assert_eq!(page, Some("import"));
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0].1, 2048);
    click(cx, "setup-import-all");
    click(cx, "setup-import-confirm");
    let (page, _, _, note) = state(&shell, cx);
    assert_eq!(page, Some("projects"));
    assert_eq!(
        note.as_deref(),
        Some(
            "None of the 2048 selected threads can be continued: their saved sessions are missing."
        )
    );
    assert_eq!(imported(&shell, cx), 3);
    assert_eq!(
        fixture
            .client
            .sessions()
            .unwrap()
            .iter()
            .filter(|s| s.id.starts_with("thoughts-import-"))
            .count(),
        3
    );
}
