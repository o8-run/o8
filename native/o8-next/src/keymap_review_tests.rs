//! Corrections exercised through the hidden production shell and key dispatcher.
use super::test_support::*;
use super::*;

fn fixture_shell(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("review.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    (fixture, shell, visual)
}
fn two_tabs(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    cx.simulate_keystrokes("cmd-k g r i d enter");
    ready(shell, cx);
    let first = cx.debug_bounds("surface-tab-0").unwrap();
    cx.simulate_click(first.center(), gpui::Modifiers::default());
    ready(shell, cx);
}
#[gpui::test]
fn review_reference_command_alias(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    cx.simulate_keystrokes("cmd-/");
    draw(&mut cx);
    assert!(
        shell.read_with(&cx, |s, _| s.shortcuts),
        "Cmd+/ must open the reference from the focused list"
    );
}
#[gpui::test]
fn review_reference_escape_closes(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    cx.simulate_keystrokes("? escape");
    draw(&mut cx);
    assert!(
        !shell.read_with(&cx, |s, _| s.shortcuts),
        "Escape must close the visible reference"
    );
}
#[gpui::test]
fn review_numbered_surface_binding(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    two_tabs(&shell, &mut cx);
    cx.simulate_keystrokes("cmd-2");
    ready(&shell, &mut cx);
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        Some(Tab::Grid),
        "Cmd+2 must select surface two"
    );
    cx.simulate_keystrokes("cmd-9");
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        Some(Tab::Grid),
        "absent surfaces keep selection"
    );
}
#[gpui::test]
fn review_directional_surface_binding(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    two_tabs(&shell, &mut cx);
    cx.simulate_keystrokes("cmd-alt-right");
    ready(&shell, &mut cx);
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        Some(Tab::Grid),
        "Cmd+Alt+Right must select the next surface"
    );
    cx.simulate_keystrokes("cmd-alt-left");
    ready(&shell, &mut cx);
    assert!(matches!(
        shell.read_with(&cx, |s, _| s.active()),
        Some(Tab::Session(_))
    ));
}
#[test]
fn review_pattern_documentation_avoids_product_attribution() {
    let attribution =
        regex::Regex::new(r"(?i)\b[a-z]+'s public|https?://[^\s)]+|\bno [a-z]+ application crates")
            .unwrap();
    for (file, source) in [
        ("keymap.rs", include_str!("keymap.rs")),
        ("terminal.rs", include_str!("terminal.rs")),
        (
            "verification.md",
            include_str!("../evidence/keymap/verification.md"),
        ),
    ] {
        assert!(
            !attribution.is_match(source),
            "{file} must describe the context pattern without naming an external product"
        );
    }
}
#[gpui::test]
#[ignore = "release CPU measurement; run explicitly without competing workloads"]
fn review_palette_release_cpu_frame_budget(cx: &mut TestAppContext) {
    assert!(
        !std::hint::black_box(cfg!(debug_assertions)),
        "measure the optimized production path"
    );
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    let mut samples = vec![];
    let mut dispatch_samples = vec![];
    let mut paint_samples = vec![];
    for i in 0..90 {
        let started = std::time::Instant::now();
        cx.update(|window, cx| {
            window.dispatch_keystroke(gpui::Keystroke::parse("cmd-k").unwrap(), cx);
        });
        let dispatch_ms = started.elapsed().as_secs_f64() * 1000.;
        cx.update(|window, cx| {
            window.draw(cx).clear();
        });
        shell.read_with(&cx, |s, _| {
            assert!(s.palette);
            assert_eq!(
                s.painted.get(),
                s.revision,
                "first CPU scene must acknowledge this action"
            );
        });
        let elapsed = started.elapsed().as_secs_f64() * 1000.;
        if i == 10 {
            println!("PALETTE_DISPATCH_FIRST_SAMPLE_MS {dispatch_ms}");
        }
        if i >= 10 {
            samples.push(elapsed);
            dispatch_samples.push(dispatch_ms);
            paint_samples.push(elapsed - dispatch_ms);
        }
        cx.update(|window, cx| {
            window.dispatch_keystroke(gpui::Keystroke::parse("escape").unwrap(), cx);
        });
        cx.update(|window, cx| {
            window.draw(cx).clear();
        });
    }
    samples.sort_by(f64::total_cmp);
    dispatch_samples.sort_by(f64::total_cmp);
    paint_samples.sort_by(f64::total_cmp);
    let median = samples[samples.len() / 2];
    let p95 = samples[(samples.len() * 95 / 100).min(samples.len() - 1)];
    println!(
        "PALETTE_CPU_FRAME {}",
        serde_json::json!({"profile":"release", "endpoint":"hidden production shell key dispatch to first CPU scene", "samples":samples.len(), "medianMs":median, "p95Ms":p95, "medianDispatchMs":dispatch_samples[dispatch_samples.len()/2], "medianPaintMs":paint_samples[paint_samples.len()/2]})
    );
    assert!(
        median < 2.,
        "palette key-to-CPU-frame median must stay under 2 ms; got {median}"
    );
}

#[gpui::test]
fn review_palette_does_not_resize_the_retained_surface(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    let before = cx.debug_bounds("shell-content").unwrap();
    cx.simulate_keystrokes("cmd-k");
    draw(&mut cx);
    assert!(shell.read_with(&cx, |s, _| s.palette));
    assert_eq!(
        cx.debug_bounds("shell-content").unwrap(),
        before,
        "palette must not resize and reflow the retained transcript"
    );
}

#[gpui::test]
fn review_reference_dismissal_restores_selected_surface_focus(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    two_tabs(&shell, &mut cx);
    let first = shell.read_with(&cx, |s, _| s.active());
    cx.simulate_keystrokes("cmd-/");
    draw(&mut cx);
    assert!(shell.read_with(&cx, |s, _| s.shortcuts));
    let grid = cx.debug_bounds("surface-tab-1").unwrap();
    cx.simulate_click(grid.center(), gpui::Modifiers::default());
    draw(&mut cx);
    assert_eq!(shell.read_with(&cx, |s, _| s.active()), Some(Tab::Grid));
    cx.simulate_keystrokes("escape");
    draw(&mut cx);
    assert!(!shell.read_with(&cx, |s, _| s.shortcuts));
    cx.simulate_keystrokes("cmd-1");
    ready(&shell, &mut cx);
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        first,
        "Cmd+/ → click Grid → Escape → Cmd+1 must return to the first surface"
    );
}

#[test]
fn review_surfaces_attach_shortcuts_only_through_the_keymap() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let raw_listener = regex::Regex::new(r"\.(?:on|capture)_key_down\s*\(").unwrap();
    let mut pending = vec![root.clone()];
    let mut offenders = vec![];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs")
                && path != root.join("keymap.rs")
                && raw_listener.is_match(&std::fs::read_to_string(&path).unwrap())
            {
                offenders.push(path.strip_prefix(&root).unwrap().to_path_buf());
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "surface raw shortcut listeners: {offenders:?}"
    );
}
