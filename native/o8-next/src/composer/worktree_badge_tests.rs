use super::*;

#[gpui::test]
fn thread_header_worktree_badge_follows_flag_and_legacy_fallback(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    for empty in [false, true] {
        for (flag, branch, expected) in [
            (Some(true), Some("main"), true),
            (Some(false), Some("topic"), false),
            (None, Some("topic"), true),
            (None, Some("main"), false),
            (None, Some("master"), false),
            (None, None, false),
            (Some(true), None, true),
        ] {
            let (surface, cx) = open(cx, &fixture);
            surface.update(cx, |s, cx| {
                let mut value = json!({
                    "id": "thoughts-badge", "runtime": "codex", "status": "idle",
                    "title": "Checkout", "repoPath": "/repo", "branch": branch,
                    "worktreePath": "/repo"
                });
                if let Some(flag) = flag {
                    value["isWorktree"] = json!(flag);
                }
                s.sessions = vec![serde_json::from_value(value).unwrap()];
                s.selected = Some("thoughts-badge".into());
                if empty {
                    s.rows = std::rc::Rc::new(Vec::new());
                }
                cx.notify();
            });
            draw(cx);
            assert_eq!(
                cx.debug_bounds("thread-worktree-badge").is_some(),
                expected,
                "flag={flag:?}, branch={branch:?}, empty={empty}"
            );
        }
    }
}
