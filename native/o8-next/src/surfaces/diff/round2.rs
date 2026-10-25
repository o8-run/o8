//! Correction round 2 through real shell controls and authenticated production routes.
use super::*;

fn open_packet(shell: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) {
    let input = cx.debug_bounds("inline-packet").unwrap();
    cx.simulate_click(input.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input(id);
    draw(cx);
    let open = cx.debug_bounds("inline-open-packet").unwrap();
    cx.simulate_click(open.center(), gpui::Modifiers::default());
    wait_inline(shell, cx);
}

fn review_approval_if_offered(
    fixture: &Fixture,
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
) -> bool {
    // GPUI keeps historical debug bounds after this control changes its selector.
    // Check the current offered action before clicking its rendered bounds.
    let offered = |cx: &VisualTestContext| {
        shell.read_with(cx, |s, cx| {
            matches!(s.content.get(&s.key(&Tab::Diff)), Some(Content::Diff(view))
                if view.read(cx).inline_review_offered())
        })
    };
    if !offered(cx) {
        return false;
    }
    let review = cx
        .debug_bounds("inline-review-approval")
        .expect("offered review control");
    let before = fixture
        .client
        .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
        .unwrap();
    cx.simulate_click(review.center(), gpui::Modifiers::default());
    wait_inline(shell, cx);
    let after = fixture
        .client
        .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
        .unwrap();
    let writes = |receipt: &Value| {
        receipt["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|request| *request == "POST /api/panel/approvals")
            .count()
    };
    assert_eq!(writes(&after), writes(&before), "review must be read-only");
    assert_eq!(after["held"], before["held"]);
    assert!(
        !offered(cx),
        "read-only review must load current approval evidence: {}",
        shell.read_with(cx, |s, cx| match s.content.get(&s.key(&Tab::Diff)) {
            Some(Content::Diff(view)) => view.read(cx).notice.clone(),
            _ => "Diff unavailable".into(),
        })
    );
    assert!(cx.debug_bounds("inline-confirm").is_some());
    true
}

#[gpui::test]
fn packet_switch_resets_the_previous_packets_base(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--inline-committed --inline-switch");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("switch.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("d i f f enter");
    wait_inline(&shell, &mut visual);
    open_packet(&shell, &mut visual, "next-inline");
    open_packet(&shell, &mut visual, "next-inline-b");
    shell.read_with(&visual, |s, cx| {
        let Some(Content::Diff(v)) = s.content.get(&s.key(&Tab::Diff)) else { panic!("Diff") };
        assert!(matches!(&v.read(cx).target, crate::diff::Target::Worktree { base: Some(base), .. } if base == "fixture-base-b"),
            "packet B must use its own lane base after packet A auto-filled Base");
        assert!(v.read(cx).document.files.is_empty(), "B's base is its HEAD");
    });
    let base = visual.debug_bounds("inline-base").unwrap();
    visual.simulate_click(base.center(), gpui::Modifiers::default());
    visual.simulate_keystrokes("ctrl-a ctrl-c");
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|v| v.text())
            .as_deref(),
        Some("fixture-base-b")
    );
    // An explicit override stays with the current packet and cannot leak on a switch back.
    visual.simulate_input("fixture-base");
    draw(&mut visual);
    let compare = visual.debug_bounds("inline-compare").unwrap();
    visual.simulate_click(compare.center(), gpui::Modifiers::default());
    wait_inline(&shell, &mut visual);
    open_packet(&shell, &mut visual, "next-inline-b");
    shell.read_with(&visual, |s, cx| {
        let Some(Content::Diff(v)) = s.content.get(&s.key(&Tab::Diff)) else {
            panic!("Diff")
        };
        assert_eq!(
            v.read(cx).document.files.len(),
            2,
            "same-packet override survives reopening"
        );
    });
    open_packet(&shell, &mut visual, "next-inline");
    shell.read_with(&visual, |s, cx| {
        let Some(Content::Diff(v)) = s.content.get(&s.key(&Tab::Diff)) else { panic!("Diff") };
        assert!(matches!(&v.read(cx).target, crate::diff::Target::Worktree { base: Some(base), .. } if base == "fixture-base"));
    });
}

#[gpui::test]
fn standalone_long_line_review_keeps_the_shared_behavior(cx: &mut TestAppContext) {
    let fixture = crate::shell::test_support::Fixture::start_mode(false, "--review");
    let repo = fs::canonicalize(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    for args in [
        vec!["rm", "large.ts", "medium.ts"],
        vec!["commit", "-qm", "compact review fixture"],
    ] {
        assert!(
            Process::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    fs::write(
        repo.join("changed.rs"),
        format!("// {}\n", "x".repeat(20_000)),
    )
    .unwrap();
    for args in [
        vec!["add", "changed.rs"],
        vec!["commit", "-qm", "long line fixture"],
    ] {
        assert!(
            Process::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let (view, visual) = cx.add_window_view(|window, cx| {
        crate::diff_ui::DiffSurface::new(
            fixture.client.clone(),
            crate::diff::Target::Packet("next-review-approve".into()),
            window,
            cx,
        )
    });
    visual.run_until_parked();
    draw(visual);
    view.read_with(visual, |v, _| {
        assert!(v.ready, "{}", v.notice);
        assert!(
            !v.document.truncated,
            "inline long-line policy must not disable standalone review"
        );
        assert!(v.document.source.contains(&"x".repeat(20_000)));
    });
    let approve = visual
        .debug_bounds("diff-approve")
        .expect("standalone approval stays enabled");
    visual.simulate_click(approve.center(), gpui::Modifiers::default());
    visual.run_until_parked();
    draw(visual);
    assert_eq!(
        fixture.client.review_state("next-review-approve").unwrap()["orchestratorReview"]["verdict"],
        "approved"
    );
}

fn held_confirmation(cx: &mut TestAppContext, change: Option<&str>, policy_held: bool) {
    held_confirmation_mode(
        cx,
        change,
        if policy_held {
            "--inline-policy-held"
        } else {
            "--inline-held"
        },
    );
}

fn held_confirmation_mode(cx: &mut TestAppContext, change: Option<&str>, mode: &str) {
    let fixture = Fixture::start_mode(false, mode);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("held.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("d i f f enter");
    wait_inline(&shell, &mut visual);
    open_packet(&shell, &mut visual, "next-inline");
    let merge = visual.debug_bounds("inline-merge").unwrap();
    visual.simulate_click(merge.center(), gpui::Modifiers::default());
    wait_inline(&shell, &mut visual);
    let before = fixture
        .client
        .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
        .unwrap();
    assert_eq!(
        before["held"]["approval"]["status"], "pending",
        "Merge must return a real held approval"
    );
    let approval = before["held"]["approval"]["id"].clone();
    if mode.contains("--inline-evidence-fail-first") {
        let review = visual
            .debug_bounds("inline-review-approval")
            .expect("missing evidence must offer read-only review recovery");
        visual.simulate_click(review.center(), gpui::Modifiers::default());
        wait_inline(&shell, &mut visual);
        let reviewed = fixture
            .client
            .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
            .unwrap();
        assert!(
            reviewed["confirmation"].is_null(),
            "review recovery must not mutate the approval"
        );
        assert_eq!(reviewed["held"]["approval"]["id"], approval);
        assert_eq!(reviewed["held"]["currentBase"], before["held"]["baseHead"]);
    }
    // The initial evidence request may also be unavailable without fault injection.
    // Follow the same explicit, non-mutating recovery before introducing gate changes.
    review_approval_if_offered(&fixture, &shell, &mut visual);
    let confirm = visual
        .debug_bounds("inline-confirm")
        .expect("a held merge must retain its approval and offer Confirm");
    if let Some(change) = change {
        let url = fixture
            .client
            .url("/api/orchestrator/inline-fixture-control")
            .unwrap();
        let response = match fixture
            .client
            .request("POST", &url)
            .send_json(json!({"change":change}))
        {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(error) => panic!("fixture {change}: {error}"),
        };
        let status = response.status();
        assert_eq!(
            status,
            200,
            "fixture {change}: {:?}",
            response.into_json::<Value>().unwrap()
        );
    }
    visual.simulate_click(confirm.center(), gpui::Modifiers::default());
    wait_inline(&shell, &mut visual);
    let mut after = fixture
        .client
        .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
        .unwrap();
    if change.is_none() && after["confirmation"].is_null() {
        let changed = shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Diff)) {
            Some(Content::Diff(v)) => v
                .read(cx)
                .notice
                .starts_with("Approval governance changed."),
            _ => false,
        });
        if changed {
            // An asynchronous annotation can invalidate the original receipt.
            // Require an explicit read-only review and a separate Confirm.
            assert_eq!(after["held"]["approval"]["status"], "pending");
            let review = visual.debug_bounds("inline-review-approval").unwrap();
            visual.simulate_click(review.center(), gpui::Modifiers::default());
            wait_inline(&shell, &mut visual);
            let reviewed = fixture
                .client
                .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
                .unwrap();
            assert!(reviewed["confirmation"].is_null());
            let confirm = visual.debug_bounds("inline-confirm").unwrap();
            visual.simulate_click(confirm.center(), gpui::Modifiers::default());
            wait_inline(&shell, &mut visual);
            after = fixture
                .client
                .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
                .unwrap();
        }
    }
    if change.is_some() {
        assert_eq!(
            after["held"]["currentBase"], before["held"]["baseHead"],
            "Confirm must refuse fresh gate changes"
        );
        assert_eq!(
            after["held"]["approval"]["status"], "pending",
            "a refusal must retain the unresolved approval"
        );
        if change != Some("race-review") {
            assert!(
                after["confirmation"].is_null(),
                "a failed preflight must not resolve the card"
            );
        }
        shell.read_with(&visual, |s, cx| {
            let Some(Content::Diff(v)) = s.content.get(&s.key(&Tab::Diff)) else {
                panic!("Diff")
            };
            assert_ne!(v.read(cx).notice, "Merged");
        });
        if change == Some("dirty") {
            let url = fixture
                .client
                .url("/api/orchestrator/inline-fixture-control")
                .unwrap();
            fixture
                .client
                .request("POST", &url)
                .send_json(json!({"change":"repair-dirty"}))
                .unwrap();
            // Model an approval annotation arriving while the desktop repairs the tree.
            fixture
                .client
                .request("POST", &url)
                .send_json(json!({"change":"governance"}))
                .unwrap();
            review_approval_if_offered(&fixture, &shell, &mut visual);
            let confirm = visual.debug_bounds("inline-confirm").unwrap();
            visual.simulate_click(confirm.center(), gpui::Modifiers::default());
            wait_inline(&shell, &mut visual);
            // Repair does not authorize new governance evidence. Follow its explicit
            // read-only review state, then issue a separate Confirm with fresh gates.
            if review_approval_if_offered(&fixture, &shell, &mut visual) {
                let confirm = visual.debug_bounds("inline-confirm").unwrap();
                visual.simulate_click(confirm.center(), gpui::Modifiers::default());
                wait_inline(&shell, &mut visual);
            }
            let repaired = fixture
                .client
                .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
                .unwrap();
            assert_eq!(
                repaired["confirmation"], approval,
                "the retained approval resolves after repairing the gate"
            );
            assert_eq!(repaired["held"]["currentBase"], before["held"]["head"]);
        }
        if change == Some("governance") {
            let review = visual
                .debug_bounds("inline-review-approval")
                .expect("changed approval evidence requires explicit read-only review");
            visual.simulate_click(review.center(), gpui::Modifiers::default());
            wait_inline(&shell, &mut visual);
            let reviewed = fixture
                .client
                .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
                .unwrap();
            assert!(
                reviewed["confirmation"].is_null(),
                "new evidence must not silently approve"
            );
            let confirm = visual.debug_bounds("inline-confirm").unwrap();
            visual.simulate_click(confirm.center(), gpui::Modifiers::default());
            wait_inline(&shell, &mut visual);
            let completed = fixture
                .client
                .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
                .unwrap();
            assert_eq!(completed["confirmation"], approval);
            assert_eq!(completed["held"]["currentBase"], before["held"]["head"]);
        }
    } else {
        let notice = shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Diff)) {
            Some(Content::Diff(v)) => v.read(cx).notice.clone(),
            _ => panic!("Diff"),
        });
        assert_eq!(
            after["confirmation"], approval,
            "Confirm resolves the exact held approval ID: {notice}"
        );
        assert_eq!(after["held"]["approval"]["status"], "approved");
        let approvals = fixture
            .client
            .get::<Value>(
                "/api/panel/approvals",
                &[("packetId", "next-inline"), ("status", "all")],
            )
            .unwrap();
        let receipt = approvals["approvals"]
            .as_array()
            .unwrap()
            .iter()
            .find(|card| card["id"] == approval)
            .unwrap();
        assert_eq!(
            after["held"]["approval"]["continuationStatus"], "completed",
            "owned continuation receipt: {}",
            receipt["resolution"]["note"]
        );
        assert_eq!(
            after["held"]["currentBase"], before["held"]["head"],
            "real continuation must advance the owned base ref"
        );
        shell.read_with(&visual, |s, cx| {
            let Some(Content::Diff(v)) = s.content.get(&s.key(&Tab::Diff)) else {
                panic!("Diff")
            };
            assert_eq!(
                v.read(cx).notice,
                "Merged",
                "the UI must confirm the persisted continuation"
            );
        });
    }
}

#[gpui::test]
fn held_merge_offers_confirm_and_completes_its_approval(cx: &mut TestAppContext) {
    held_confirmation(cx, None, false);
}

#[gpui::test]
fn held_confirm_rereads_head_review_contract_and_runtime(cx: &mut TestAppContext) {
    for change in [
        "head",
        "review",
        "contract",
        "runtime",
        "stop",
        "restriction",
        "dirty",
    ] {
        held_confirmation(cx, Some(change), false);
    }
}

#[gpui::test]
fn policy_held_merge_confirms_its_current_approval(cx: &mut TestAppContext) {
    held_confirmation(cx, None, true);
    held_confirmation_mode(
        cx,
        None,
        "--inline-policy-held --inline-evidence-fail-first",
    );
}

#[gpui::test]
fn held_confirm_fences_governance_change_before_the_approval_claim(cx: &mut TestAppContext) {
    held_confirmation(cx, Some("race-review"), false);
}

#[gpui::test]
fn held_confirm_recovers_a_lost_completed_receipt(cx: &mut TestAppContext) {
    held_confirmation_mode(cx, None, "--inline-held --inline-confirm-drop-first");
}

#[gpui::test]
fn held_approval_recovers_when_initial_evidence_is_unavailable(cx: &mut TestAppContext) {
    held_confirmation_mode(cx, None, "--inline-held --inline-evidence-fail-first");
}

#[gpui::test]
fn changed_approval_evidence_requires_read_only_review_before_confirm(cx: &mut TestAppContext) {
    held_confirmation(cx, Some("governance"), false);
}
