//! #5303 PR 2a: the agent and tools step ported from the desktop
//! (OnboardingDispatchStep, AgentReadiness, OnboardingToolsPanel), against the
//! fixture's fixed tool inventory (`--onboarding-tools`).
use super::*;

fn setup_view(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<setup::view::Setup> {
    shell.read_with(cx, |s, _| {
        s.surfaces.setup.view.clone().expect("setup open")
    })
}
fn choice(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> (String, Vec<String>) {
    let setup = setup_view(shell, cx);
    setup.read_with(cx, |s, _| s.tools_choice())
}
fn inside(cx: &mut VisualTestContext, inner: &'static str, outer: &str) -> bool {
    let outer: &'static str = Box::leak(outer.to_owned().into_boxed_str());
    match (cx.debug_bounds(inner), cx.debug_bounds(outer)) {
        (Some(inner), Some(outer)) => {
            inner.top() >= outer.top()
                && inner.bottom() <= outer.bottom()
                && inner.left() >= outer.left()
                && inner.right() <= outer.right()
        }
        _ => false,
    }
}

#[gpui::test]
fn onboarding_tools_step_matches_the_desktop_choices(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --onboarding-tools --transcript");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("tools.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    // Home: the desktop's tools line, with the lead's readiness card.
    assert!(cx.debug_bounds("setup-tools-line").is_some());
    assert!(cx.debug_bounds("setup-ready-codex").is_some());
    // Ready tools skip this step when a project opens; Change opens it.
    click(cx, "setup-change-tools");
    assert!(cx.debug_bounds("setup-tools").is_some());

    // Readiness cards for the primary tools; the chosen lead shows it.
    assert!(cx.debug_bounds("setup-agent-codex").is_some());
    assert!(cx.debug_bounds("setup-agent-claude-code").is_some());
    assert!(
        cx.debug_bounds("setup-agent-opencode").is_none(),
        "the desktop's cards show Codex, Claude Code and the lead"
    );
    assert_eq!(choice(&shell, cx), ("codex".into(), vec!["codex".into()]));
    assert!(inside(cx, "setup-agent-selected", "setup-agent-codex"));
    click(cx, "setup-agent-claude-code");
    assert_eq!(
        choice(&shell, cx),
        ("claude".into(), vec!["claude-code".into()]),
        "a new lead also becomes the worker while workers are the default"
    );
    assert!(inside(
        cx,
        "setup-agent-selected",
        "setup-agent-claude-code"
    ));
    assert!(!inside(cx, "setup-agent-selected", "setup-agent-codex"));

    // Customize: workers with their check boxes, and the lead picker.
    click(cx, "setup-customize");
    assert!(cx.debug_bounds("setup-customization").is_some());
    click(cx, "setup-worker-codex");
    assert_eq!(
        choice(&shell, cx).1,
        ["claude-code", "codex"],
        "a ready tool joins the workers"
    );
    click(cx, "setup-worker-opencode");
    assert_eq!(
        choice(&shell, cx).1,
        ["claude-code", "codex"],
        "a tool that needs sign-in cannot be chosen"
    );
    click(cx, "setup-lead-picker");
    for option in ["codex", "claude", "fable", "o8"] {
        let id: &'static str = Box::leak(format!("setup-lead-option-{option}").into_boxed_str());
        assert!(cx.debug_bounds(id).is_some(), "{id}");
    }
    assert!(
        cx.debug_bounds("setup-lead-option-opencode").is_none(),
        "only ready leads are offered"
    );
    click(cx, "setup-lead-option-codex");
    assert_eq!(
        choice(&shell, cx),
        ("codex".into(), vec!["claude-code".into(), "codex".into()]),
        "while customizing, the lead never changes the workers"
    );
    click(cx, "setup-customize");
    assert!(cx.debug_bounds("setup-customization").is_none());

    // Add coding tools: readiness, install commands and setup links.
    click(cx, "setup-add-tools");
    assert!(cx.debug_bounds("setup-tool-setup").is_some());
    assert!(cx.debug_bounds("setup-tool-opencode").is_some());
    assert!(
        cx.debug_bounds("setup-copy-opencode").is_none(),
        "an installed tool that needs sign-in has no install command"
    );
    click(cx, "setup-copy-gemini");
    assert_eq!(
        cx.read_from_clipboard().and_then(|item| item.text()),
        Some("npm i -g @google/gemini-cli".into())
    );
    assert!(cx.debug_bounds("setup-instructions-gemini").is_none());
    click(cx, "setup-instructions-antigravity");
    assert_eq!(
        cx.opened_url(),
        Some("https://antigravity.google/docs/getting-started?tab=cli".into())
    );
    // A rescan keeps the choice.
    click(cx, "setup-refresh-tools");
    assert_eq!(
        choice(&shell, cx),
        ("codex".into(), vec!["claude-code".into(), "codex".into()])
    );
    click(cx, "setup-back-choices");
    assert!(cx.debug_bounds("setup-agent-readiness").is_some());
    // With no project chosen, Use this setup saves and returns to projects.
    click(cx, "setup-use");
    assert!(cx.debug_bounds("setup-projects").is_some());
    assert!(cx.debug_bounds("setup-saved").is_some());
    let saved: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_eq!(saved["values"]["orchestratorBackend"], "codex");
    assert_eq!(
        saved["values"]["workerRuntimes"],
        json!(["claude-code", "codex"])
    );
    assert_eq!(saved["values"]["defaultDispatchRuntime"], "claude-code");
}

#[gpui::test]
fn onboarding_tools_scan_turns_slow_after_three_seconds(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --onboarding-tools --transcript");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("slow-scan.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-change-tools");
    let setup = setup_view(&shell, cx);
    setup.update(cx, |s, cx| s.begin_slow_scan(cx));
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(2_900));
    cx.run_until_parked();
    assert!(!setup.read_with(cx, |s, _| s.scan_slow()));
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(200));
    cx.run_until_parked();
    draw(cx);
    assert!(setup.read_with(cx, |s, _| s.scan_slow()));
    assert!(cx.debug_bounds("setup-scan-status").is_some());
}
