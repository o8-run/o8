//! #5304: a finished `!` card stays with its thread across a relaunch.
use super::*;
use crate::composer::{mode_store, shell::SavedRun};

const THREAD: &str = "thoughts-composer-first";

fn store(fixture: &Fixture, thread: &str, cx: &mut TestAppContext) -> Option<std::path::PathBuf> {
    let server = fixture
        .client
        .url("/")
        .map(|u| u.to_string())
        .unwrap_or_default();
    cx.update(|cx| mode_store::path(&server, thread, cx))
}
fn kept() -> SavedRun {
    SavedRun {
        line: "git status --short".into(),
        output: vec![" M src/main.rs".into(), "?? notes.md".into()],
        took_ms: 640,
        exit: Some(0),
        stopped: false,
        lost: false,
    }
}
fn card(
    surface: &gpui::Entity<Surface>,
    cx: &VisualTestContext,
) -> Option<crate::composer::shell::ShellRun> {
    surface.read_with(cx, |s, _| s.shell_run().cloned())
}

#[gpui::test]
fn native_shell_card_comes_back_with_its_thread_after_a_relaunch(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let root = crate::shell::test_support::scratch_path("o8-shell-cards");
    cx.update(|cx| cx.set_global(mode_store::TestRoot(root)));
    // The last launch finished a `!` line in this thread and kept its card.
    let path = store(&fixture, THREAD, cx);
    assert!(path.is_some());
    mode_store::save_shell_run(path.as_deref(), Some(&kept())).unwrap();

    let (surface, cx) = open(cx, &fixture);
    let run = card(&surface, cx).expect("the kept card is back");
    assert!(run.restored && !run.running());
    assert_eq!(run.output, kept().output);
    assert_eq!(
        run.status(std::time::Instant::now()),
        "Finished · 0.6s · exit 0"
    );
    draw(cx);
    assert!(cx.debug_bounds("composer-shell-status-finished").is_some());
    assert!(cx.debug_bounds("composer-shell-output").is_some());

    // It belongs to its thread: another thread shows none, and coming back
    // shows it again.
    let other = fixture
        .client
        .sessions()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .find(|id| id != THREAD)
        .expect("a second thread");
    surface.update(cx, |s, cx| s.select(other.clone(), cx));
    cx.run_until_parked();
    assert!(card(&surface, cx).is_none(), "another thread has no card");
    surface.update(cx, |s, cx| s.select(THREAD.into(), cx));
    cx.run_until_parked();
    assert!(card(&surface, cx).is_some_and(|run| run.restored));

    // Add to chat uses the kept output (the terminal is gone) and clears it.
    click("composer-shell-add", cx);
    let draft = surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone());
    assert!(
        draft.starts_with("```console\n$ git status --short\n M src/main.rs\n?? notes.md\n```"),
        "{draft}"
    );
    assert!(card(&surface, cx).is_none());
    assert!(
        mode_store::load_shell_run(path.as_deref()).is_none(),
        "added cards are not kept"
    );

    // Dismiss also clears it for good.
    mode_store::save_shell_run(path.as_deref(), Some(&kept())).unwrap();
    surface.update(cx, |s, cx| s.select(THREAD.into(), cx));
    cx.run_until_parked();
    click("composer-shell-dismiss", cx);
    assert!(card(&surface, cx).is_none());
    assert!(mode_store::load_shell_run(path.as_deref()).is_none());
    surface.update(cx, |s, cx| s.select(THREAD.into(), cx));
    assert!(card(&surface, cx).is_none(), "a dismissed card stays gone");
}

#[test]
fn a_kept_card_holds_the_add_to_chat_tail_of_its_output() {
    let mut run = crate::composer::shell::ShellRun::new("yes".into(), std::time::Instant::now());
    assert!(run.saved().is_none(), "a running card is not kept");
    run.output = (0..500).map(|i| format!("line {i}")).collect();
    run.took = Some(std::time::Duration::from_millis(1234));
    run.exit = Some(0);
    let saved = run.saved().unwrap();
    assert_eq!(saved.took_ms, 1234);
    assert!(saved.output.len() <= crate::composer::shell::OUTPUT_LINES);
    assert_eq!(saved.output.last().unwrap(), "line 499");
    let chars: usize = saved.output.iter().map(|l| l.chars().count() + 1).sum();
    assert!(chars <= crate::composer::shell::OUTPUT_CHARS);
    let back =
        crate::composer::shell::ShellRun::restore(saved.clone(), None, std::time::Instant::now());
    assert_eq!(back.saved(), Some(saved));
}

#[gpui::test]
fn native_shell_card_status_never_clips_and_actions_wrap_when_narrow(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let root = crate::shell::test_support::scratch_path("o8-shell-card-header");
    cx.update(|cx| cx.set_global(mode_store::TestRoot(root)));
    let path = store(&fixture, THREAD, cx);
    mode_store::save_shell_run(path.as_deref(), Some(&kept())).unwrap();
    let (_surface, cx) = open(cx, &fixture);
    let layout = |cx: &mut VisualTestContext, width: f32| {
        cx.simulate_resize(gpui::size(px(width), px(900.)));
        draw(cx);
        let card = cx.debug_bounds("composer-shell-run").expect("card");
        let status = cx
            .debug_bounds("composer-shell-status-finished")
            .expect("status");
        let actions = cx.debug_bounds("composer-shell-actions").expect("actions");
        (card, status, actions)
    };
    let (card, status, actions) = layout(cx, 1400.);
    assert!(status.right() <= card.right());
    assert!(
        actions.top() < status.bottom(),
        "a wide card keeps one header row"
    );
    let wide_status = status.size.width;
    let (card, status, actions) = layout(cx, 520.);
    assert!(
        status.right() <= card.right(),
        "the status stays inside the card"
    );
    assert_eq!(
        status.size.width, wide_status,
        "the status keeps its full text"
    );
    assert!(
        actions.top() >= status.bottom(),
        "narrow, the buttons take their own row"
    );
    assert!(actions.right() <= card.right());
}
