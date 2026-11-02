use crate::{client::Client, diff::Target, diff_ui::DiffSurface};
use gpui::TestAppContext;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    time::Instant,
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.0.id().to_string()])
            .status();
        let _ = self.0.wait();
    }
}
fn fixture() -> (Server, Client) {
    let mut child = Command::new("node")
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "scripts/next/dev-server.ts",
            "--review",
            "--review-drop-first",
            "--owned-stdio",
        ])
        .env("O8_NEXT_API_TOKEN", "fixture-next-review-operator")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let origin = reader
        .by_ref()
        .lines()
        .find_map(|line| {
            serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                .as_str()
                .map(str::to_owned)
        })
        .expect("disposable fixture origin");
    std::thread::spawn(move || for _ in reader.lines() {});
    (
        Server(child),
        Client::authenticated(&origin, Some("fixture-next-review-operator".into())).unwrap(),
    )
}

#[gpui::test]
fn diff_real_server_selection_modes_review_and_virtualized_paint(cx: &mut TestAppContext) {
    let (_server, client) = fixture();
    let saved = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| {
        DiffSurface::new(
            client,
            Target::Packet("next-review-reject".into()),
            window,
            cx,
        )
    });
    cx.run_until_parked();
    view.read_with(cx, |s, _| {
        assert!(s.ready, "{}", s.notice);
        let states: Vec<_> = s.document.files.iter().map(|f| f.status.as_str()).collect();
        for status in ["added", "deleted", "renamed", "modified"] {
            assert!(states.contains(&status));
        }
        let renamed = s
            .document
            .files
            .iter()
            .find(|f| f.status == "renamed")
            .unwrap();
        assert_eq!(renamed.old_path, "old name.md");
        assert_eq!(renamed.path, "new name.md");
    });
    // Exercise actual GPUI controls, including server-backed decision refresh.
    let file = cx.debug_bounds("diff-file-1").unwrap();
    cx.simulate_click(file.center(), gpui::Modifiers::default());
    assert_eq!(
        view.read_with(cx, |s, _| s.document.files[s.selected].path.clone()),
        "changed.rs"
    );
    let split = cx.debug_bounds("diff-split").unwrap();
    cx.simulate_click(split.center(), gpui::Modifiers::default());
    assert!(view.read_with(cx, |s, _| s.split));
    let reject = cx.debug_bounds("diff-reject").unwrap();
    cx.simulate_click(reject.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    assert!(view.read_with(cx, |s, _| s.notice.contains("unconfirmed")));
    let retry = cx.debug_bounds("diff-retry").unwrap();
    cx.simulate_click(retry.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    assert_eq!(
        saved.review_state("next-review-reject").unwrap()["orchestratorReview"]["verdict"],
        "rejected"
    );
    assert!(view.read_with(cx, |s, _| s.notice.contains("rejected")));
    view.update(cx, |s, cx| {
        s.target = Target::Packet("next-review-approve".into());
        s.load(cx);
    });
    cx.run_until_parked();
    let approve = cx.debug_bounds("diff-approve").unwrap();
    let old_bounds = approve;
    cx.simulate_click(approve.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    assert_eq!(
        saved.review_state("next-review-approve").unwrap()["orchestratorReview"]["verdict"],
        "approved"
    );
    assert!(view.read_with(cx, |s, _| s.notice.contains("approved")));

    // A changed working-tree body at the same HEAD cannot silently inherit the
    // displayed approval. Drive the same control and verify persisted state.
    let repo = saved.sessions().unwrap()[0].repo_path.clone().unwrap();
    let added = std::path::Path::new(&repo).join("added.ts");
    std::fs::write(&added, "export const answer: number = 43;\n").unwrap();
    let reject = cx.debug_bounds("diff-reject").unwrap();
    cx.simulate_click(reject.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    let notice = view.read_with(cx, |s, _| s.notice.clone());
    assert!(
        notice.contains("Diff changed"),
        "changed diff refusal: {notice}"
    );
    assert_eq!(
        saved.review_state("next-review-approve").unwrap()["orchestratorReview"]["verdict"],
        "approved"
    );
    std::fs::write(&added, "export const answer: number = 42;\n").unwrap();
    let git = |args: &[&str]| {
        assert!(
            Command::new("git")
                .args(["-C", &repo])
                .args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
    };
    git(&["config", "color.ui", "always"]);
    view.update(cx, |s, cx| s.load(cx));
    cx.run_until_parked();
    assert!(view.read_with(cx, |s, _| s.document.unsupported));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    // The action disappears for an unsupported document. Clicking its saved
    // position must still leave the server's receipt unchanged.
    let approval = saved.review_state("next-review-approve").unwrap()["orchestratorReview"].clone();
    assert!(cx.debug_bounds("diff-approve").is_none());
    cx.simulate_click(old_bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    assert!(view.read_with(cx, |s, _| s.notice.contains("Unsupported")
        || s.notice.contains("truncated")));
    assert_eq!(
        saved.review_state("next-review-approve").unwrap()["orchestratorReview"],
        approval
    );
    git(&["config", "color.ui", "false"]);
    let huge = std::path::Path::new(&repo).join("zz-large.ts");
    std::fs::write(&huge, format!("// {}\n", "x".repeat(600_000))).unwrap();
    git(&["add", "zz-large.ts"]);
    view.update(cx, |s, cx| s.load(cx));
    cx.run_until_parked();
    assert!(view.read_with(cx, |s, _| s.document.truncated));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    cx.simulate_click(old_bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    assert!(
        view.read_with(cx, |s, _| s.notice.contains("truncated")),
        "truncated diff refusal: {}",
        view.read_with(cx, |s, _| s.notice.clone())
    );
    assert_eq!(
        saved.review_state("next-review-approve").unwrap()["orchestratorReview"],
        approval
    );
    git(&["rm", "-f", "zz-large.ts"]);

    let mut evidence = vec![];
    for split in [false, true] {
        let control = cx
            .debug_bounds(if split { "diff-split" } else { "diff-unified" })
            .unwrap();
        cx.simulate_click(control.center(), gpui::Modifiers::default());
        for (path, lines) in [("medium.ts", 1_000), ("large.ts", 20_000)] {
            let started = Instant::now();
            view.update(cx, |s, cx| {
                s.target = Target::Worktree {
                    path: repo.clone(),
                    base: Some("main".into()),
                    file: Some(path.into()),
                };
                s.document = std::rc::Rc::new(Default::default());
                s.load(cx);
            });
            cx.run_until_parked();
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear();
            });
            let open_ms = started.elapsed().as_secs_f64() * 1000.;
            let count = view.read_with(cx, |s, _| s.row_count());
            assert!(
                view.read_with(cx, |s, _| s.ready),
                "selected-file HTTP load must finish before paint timing ends"
            );
            assert_eq!(
                view.read_with(cx, |s, _| s.document.files[s.selected].additions),
                lines
            );
            assert!(view.read_with(cx, |s, _| s.painted.borrow().contains(&0)));
            let mut frames = vec![];
            let mut max_painted = 0;
            for i in 0..50 {
                let target = if i % 2 == 0 { count - 1 } else { 0 };
                let started = Instant::now();
                view.update(cx, |s, cx| {
                    s.painted.borrow_mut().clear();
                    s.scroll_to(target, cx);
                });
                cx.update(|window, cx| {
                    window.refresh();
                    window.draw(cx).clear();
                });
                frames.push(started.elapsed().as_secs_f64() * 1000.);
                view.read_with(cx, |s, _| {
                    assert!(
                        s.painted.borrow().contains(&target),
                        "scroll target must reach its paint callback"
                    );
                    max_painted = max_painted.max(s.painted.borrow().len());
                });
            }
            assert!(
                max_painted < 100,
                "virtualization must bound scene rows independently of diff length"
            );
            frames.sort_by(f64::total_cmp);
            view.update(cx, |s, cx| s.scroll_to(0, cx));
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear();
            });
            let viewport = cx.debug_bounds("diff-viewport").unwrap();
            let mut wheels = vec![];
            for _ in 0..50 {
                view.update(cx, |s, _| s.painted.borrow_mut().clear());
                let started = Instant::now();
                cx.simulate_event(gpui::ScrollWheelEvent {
                    position: viewport.center(),
                    delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(-240.))),
                    ..Default::default()
                });
                cx.update(|window, cx| {
                    window.refresh();
                    window.draw(cx).clear();
                });
                wheels.push(started.elapsed().as_secs_f64() * 1000.);
                assert!(view.read_with(cx, |s, _| !s.painted.borrow().is_empty()
                    && s.painted.borrow().len() < 100));
            }
            wheels.sort_by(f64::total_cmp);
            let memory = std::fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|s| s.starts_with("VmRSS:"))
                        .and_then(|s| s.split_whitespace().nth(1))
                        .and_then(|s| s.parse::<f64>().ok())
                })
                .map(|kb| kb / 1024.);
            evidence.push(json!({"mode":if split { "split" } else { "unified" }, "changedLines": lines, "openToFirstPaintMs": open_ms,
            "scrollFrameP95Ms":wheels[47], "jumpFrameP95Ms":frames[47], "wheelFrameMsSorted":wheels,
            "jumpFrameMsSorted":frames, "rssMiB": memory, "maxPaintedRows":max_painted, "rows":count}));
        }
    }
    let receipt = json!({"endpoint":"Linux GPUI TestAppContext CPU scene paint with test text system; no native font shaping, GPU or compositor presentation", "samples":evidence});
    println!("O8_NEXT_DIFF_EVIDENCE {receipt}");
    if let Ok(path) = std::env::var("O8_NEXT_DIFF_EVIDENCE") {
        std::fs::write(path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
}

#[test]
fn diff_parser_highlights_languages_preserves_bytes_and_pairs_changes() {
    for (path, source) in [
        ("sample.ts", "export const é: string = \"雪\";"),
        ("sample.rs", "pub fn main() { let n = 42; }"),
        ("sample.md", "A **strong** [link](url) and `code`"),
        ("sample.json", "{\"answer\":42,\"ok\":true}"),
    ] {
        let document = crate::diff::parse(&format!(
            "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+{source}\n"
        ));
        let line = document.files[0]
            .lines
            .iter()
            .find(|line| line.new == Some(1))
            .unwrap();
        assert_eq!(line.text, source);
        assert!(
            !line.highlights.is_empty(),
            "{path} requires tree-sitter styles"
        );
        for (span, _) in &line.highlights {
            assert!(line.text.is_char_boundary(span.start) && line.text.is_char_boundary(span.end));
        }
    }
    let doc = crate::diff::parse(
        "diff --git a/change.ts b/change.ts\n--- a/change.ts\n+++ b/change.ts\n@@ -10,3 +10,2 @@\n-a\n-b\n+z\n c\n@@ -30 +29 @@\n-old\n+new\n\\ No newline at end of file\n",
    );
    let file = &doc.files[0];
    assert_eq!((file.additions, file.deletions), (2, 3));
    assert_eq!(file.split[1], (Some(1), Some(3)));
    assert_eq!(file.split[2], (Some(2), None));
    assert_eq!((file.lines[4].old, file.lines[4].new), (Some(12), Some(11)));
    assert_eq!(file.lines.last().unwrap().kind, crate::diff::Kind::Meta);
    let binary = crate::diff::parse(
        "diff --git \"a/\\303\\251.json\" \"b/\\303\\251.json\"\nBinary files differ\n",
    );
    assert_eq!(binary.files[0].path, "é.json");
    assert!(binary.files[0].lines[0].text.contains("Binary"));
    let metadata =
        crate::diff::parse("diff --git a/mode.rs b/mode.rs\nold mode 100644\nnew mode 100755\n");
    assert_eq!(metadata.files[0].path, "mode.rs");
    assert!(
        metadata.files[0]
            .lines
            .iter()
            .any(|line| line.text == "old mode 100644")
    );
    assert!(
        metadata.files[0]
            .lines
            .iter()
            .any(|line| line.text == "new mode 100755")
    );
    for patch in [
        "external diff output with no unified patch\n",
        "\u{1b}[1mdiff --git a/a.ts b/a.ts\u{1b}[m\n",
        "diff --git a/a b/a\n@@ -0,0 +1,2 @@\n+one\n",
    ] {
        assert!(crate::diff::parse(patch).unsupported);
    }
}
