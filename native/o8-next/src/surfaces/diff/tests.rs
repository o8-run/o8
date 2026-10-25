use super::*;
use crate::shell::test_support::*;
struct Fixture(crate::shell::test_support::Fixture);
impl std::ops::DerefMut for Fixture {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl std::ops::Deref for Fixture {
    type Target = crate::shell::test_support::Fixture;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Fixture {
    fn new() -> Self {
        Self::start_mode(false, "")
    }
    fn start_mode(projects: bool, option: &str) -> Self {
        Self(crate::shell::test_support::Fixture::start_mode(
            projects,
            &format!("{option} --inline"),
        ))
    }
    fn mode(brain: bool, settings: bool, committed: bool) -> Self {
        let mut args = Vec::new();
        if brain {
            args.push("--brain");
        }
        if settings {
            args.push("--settings");
        }
        if committed {
            args.push("--inline-committed");
        }
        Self::start_mode(false, &args.join(" "))
    }
}
#[gpui::test]
fn inline_diff_is_reachable_from_shell(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("inline.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("d i f f enter");
    draw(&mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active().unwrap().label()),
        "Diff",
        "inline diff must be reachable through the real shell palette"
    );
    assert!(visual.debug_bounds("inline-copy").is_some());
}

fn wait_inline(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..30 {
        cx.run_until_parked();
        draw(cx);
        if shell.read_with(cx,|s,cx|matches!(s.content.get(&s.key(&Tab::Diff)),Some(Content::Diff(view)) if view.read(cx).inline_idle())) {return;}
    }
    panic!("inline diff action must settle and paint");
}
#[gpui::test]
fn inline_diff_hunks_copy_refresh_and_merge_refusal(cx: &mut TestAppContext) {
    let mut fixture = Fixture::new();
    let workspace = fs::canonicalize(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("inline-actions.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let cx = &mut visual;
    let started = Instant::now();
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("d i f f enter");
    wait_inline(&shell, cx);
    let open_ms = started.elapsed().as_secs_f64() * 1000.;
    let rows = |shell: &Entity<Shell>, cx: &VisualTestContext| {
        shell.read_with(cx, |s, cx| {
            match s.content.get(&s.key(&Tab::Diff)).unwrap() {
                Content::Diff(view) => view.read(cx).row_count(),
                _ => 0,
            }
        })
    };
    let before = rows(&shell, cx);
    let collapse = cx.debug_bounds("inline-collapse-0").unwrap();
    let started = Instant::now();
    cx.simulate_click(collapse.center(), gpui::Modifiers::default());
    draw(cx);
    let interaction_ms = started.elapsed().as_secs_f64() * 1000.;
    assert!(rows(&shell, cx) < before);
    cx.simulate_click(collapse.center(), gpui::Modifiers::default());
    draw(cx);
    assert_eq!(rows(&shell, cx), before);
    let copy = cx.debug_bounds("inline-copy").unwrap();
    cx.simulate_click(copy.center(), gpui::Modifiers::default());
    let complete = cx
        .read_from_clipboard()
        .and_then(|item| item.text())
        .unwrap();
    for number in [10, 60, 110] {
        assert!(complete.contains(&format!("+export const line{number} = 999;")));
    }
    let skip = cx.debug_bounds("inline-none").unwrap();
    cx.simulate_click(skip.center(), gpui::Modifiers::default());
    draw(cx);
    cx.write_to_clipboard(gpui::ClipboardItem::new_string(
        "fixture unchanged clipboard".into(),
    ));
    cx.simulate_click(copy.center(), gpui::Modifiers::default());
    assert_eq!(
        cx.read_from_clipboard()
            .and_then(|item| item.text())
            .unwrap(),
        "fixture unchanged clipboard"
    );
    let middle = cx.debug_bounds("inline-hunk-1").unwrap();
    cx.simulate_click(middle.center(), gpui::Modifiers::default());
    draw(cx);
    cx.simulate_click(copy.center(), gpui::Modifiers::default());
    let patch = cx
        .read_from_clipboard()
        .and_then(|item| item.text())
        .unwrap();
    assert!(patch.contains("+export const line60 = 999;"));
    assert!(!patch.contains("+export const line10 = 999;"));
    assert!(!patch.contains("other.txt"));
    let clone = fixture.root.join("patch-check");
    assert!(
        Process::new("git")
            .args(["clone", "--no-hardlinks", "-q"])
            .arg(&workspace)
            .arg(&clone)
            .status()
            .unwrap()
            .success()
    );
    let patch_file = fixture.root.join("selected.patch");
    fs::write(&patch_file, &patch).unwrap();
    for args in [vec!["apply", "--check"], vec!["apply"]] {
        assert!(
            Process::new("git")
                .arg("-C")
                .arg(&clone)
                .args(args)
                .arg(&patch_file)
                .status()
                .unwrap()
                .success()
        );
    }
    let applied = fs::read_to_string(clone.join("changed.ts")).unwrap();
    let lines: Vec<_> = applied.lines().collect();
    assert_eq!(lines[9], "export const line10 = 10;");
    assert_eq!(lines[59], "export const line60 = 999;");
    assert_eq!(lines[109], "export const line110 = 110;");
    let refresh = cx.debug_bounds("diff-refresh").unwrap();
    cx.simulate_click(refresh.center(), gpui::Modifiers::default());
    wait_inline(&shell, cx);
    cx.simulate_click(copy.center(), gpui::Modifiers::default());
    assert_eq!(
        cx.read_from_clipboard()
            .and_then(|item| item.text())
            .unwrap(),
        patch
    );
    let all = cx.debug_bounds("inline-all").unwrap();
    cx.simulate_click(all.center(), gpui::Modifiers::default());
    draw(cx);
    cx.simulate_click(copy.center(), gpui::Modifiers::default());
    assert_eq!(
        cx.read_from_clipboard()
            .and_then(|item| item.text())
            .unwrap(),
        complete
    );
    let other = cx.debug_bounds("diff-file-1").unwrap();
    cx.simulate_click(other.center(), gpui::Modifiers::default());
    draw(cx);
    shell.read_with(cx, |s, cx| {
        if let Content::Diff(view) = s.content.get(&s.key(&Tab::Diff)).unwrap() {
            assert_eq!(
                view.read(cx).document.files[view.read(cx).selected].path,
                "other.txt"
            );
        }
    });
    let modified = fs::read(workspace.join("changed.ts")).unwrap();
    let other_modified = fs::read(workspace.join("other.txt")).unwrap();
    assert!(
        Process::new("git")
            .arg("-C")
            .arg(&workspace)
            .args(["checkout", "--", "changed.ts", "other.txt"])
            .status()
            .unwrap()
            .success()
    );
    cx.simulate_click(refresh.center(), gpui::Modifiers::default());
    wait_inline(&shell, cx);
    shell.read_with(cx, |s, cx| {
        if let Content::Diff(view) = s.content.get(&s.key(&Tab::Diff)).unwrap() {
            assert!(view.read(cx).document.files.is_empty());
            assert_eq!(view.read(cx).notice, "No changes");
        }
    });
    fs::write(workspace.join("changed.ts"), modified).unwrap();
    fs::write(workspace.join("other.txt"), other_modified).unwrap();
    let base = cx.debug_bounds("inline-base").unwrap();
    cx.simulate_click(base.center(), gpui::Modifiers::default());
    cx.simulate_input("fixture-missing");
    draw(cx);
    let compare = cx.debug_bounds("inline-compare").unwrap();
    cx.simulate_click(compare.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
    shell.read_with(cx, |s, cx| if let Content::Diff(view) = s.content.get(&s.key(&Tab::Diff)).unwrap() {
        assert!(view.read(cx).ready, "the production route retains its missing-base dirty-tree fallback");
        assert_eq!(view.read(cx).document.files.len(), 2);
        assert!(matches!(&view.read(cx).target, crate::diff::Target::Worktree { base: Some(base), .. } if base == "fixture-missing"), "diff shortcuts must not consume text input");
    });
    cx.simulate_click(base.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("main");
    cx.simulate_click(compare.center(), gpui::Modifiers::default());
    wait_inline(&shell, cx);
    let packet = cx.debug_bounds("inline-packet").unwrap();
    cx.simulate_click(packet.center(), gpui::Modifiers::default());
    cx.simulate_input("next-inline");
    draw(cx);
    let choose = cx.debug_bounds("inline-open-packet").unwrap();
    cx.simulate_click(choose.center(), gpui::Modifiers::default());
    wait_inline(&shell, cx);
    let merge = cx
        .debug_bounds("inline-merge")
        .expect("verified packet context exposes Merge lane");
    cx.simulate_click(merge.center(), gpui::Modifiers::default());
    wait_inline(&shell, cx);
    shell.read_with(cx, |s, cx| {
        if let Content::Diff(view) = s.content.get(&s.key(&Tab::Diff)).unwrap() {
            assert!(!view.read(cx).notice.is_empty());
            assert_ne!(view.read(cx).notice, "Merged");
            println!("INLINE_MERGE_REFUSAL {}", view.read(cx).notice);
        }
    });
    let receipt = fixture
        .client
        .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
        .unwrap();
    let _ = Process::new("kill")
        .args(["-TERM", &fixture.server.id().to_string()])
        .status();
    let _ = fixture.server.wait();
    assert!(
        receipt["requests"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r == "POST /api/orchestrator/merge")
    );
    cx.simulate_click(refresh.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
    shell.read_with(cx, |s, cx| {
        if let Content::Diff(view) = s.content.get(&s.key(&Tab::Diff)).unwrap() {
            assert!(!view.read(cx).ready);
            assert!(view.read(cx).notice.contains("Could not reach"));
        }
    });
    println!(
        "O8_NEXT_INLINE_EVIDENCE {}",
        json!({"endpoint":"GPUI TestAppContext CPU scene; no GPU/compositor","openToFirstFrameMs":open_ms,"interactionToFrameMs":interaction_ms,"partialPatchApplied":true,"mergeRefusals":1})
    );
}

#[path = "corrections.rs"]
mod corrections;

#[path = "boundaries.rs"]
mod boundaries;
