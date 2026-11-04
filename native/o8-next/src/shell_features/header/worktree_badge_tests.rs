use super::*;
use crate::shell::test_support::*;

#[gpui::test]
fn thread_header_worktree_badge_follows_flag_and_legacy_fallback(cx: &mut TestAppContext) {
    for empty in [false, true] {
        let fixture = Fixture::start_mode(false, if empty { "--composer-empty" } else { "" });
        let (shell, mut visual) = open(
            fixture.client.clone(),
            fixture.root.join("header-worktree.json"),
            crate::shell_state::State::default(),
            cx,
        );
        ready(&shell, &mut visual);
        for (width, height) in [(900., 700.), (1680., 1050.)] {
            visual.simulate_resize(size(px(width), px(height)));
            for (flag, branch, expected) in [
                (Some(true), Some("main"), true),
                (Some(false), Some("topic"), false),
                (None, Some("topic"), true),
                (None, Some("main"), false),
                (None, Some("master"), false),
                (None, Some(""), false),
                (None, None, false),
                (Some(true), None, true),
            ] {
                shell.update(&mut visual, |s, cx| {
                    let Tab::Session(id) = s.active().unwrap() else {
                        panic!("thread tab")
                    };
                    let selected = s.current().unwrap().selections.get(&id).unwrap_or(&id);
                    let selected = selected.clone();
                    let session = s.sessions.iter_mut().find(|s| s.id == selected).unwrap();
                    let mut value = json!({
                        "id": selected, "runtime": session.runtime, "status": "idle",
                        "title": "Checkout", "repoPath": "/repo", "branch": branch,
                        "worktreePath": "/repo"
                    });
                    if let Some(flag) = flag {
                        value["isWorktree"] = json!(flag);
                    }
                    *session = serde_json::from_value(value).unwrap();
                    let Content::Session(view) =
                        s.content.get(&s.key(&s.active().unwrap())).unwrap()
                    else {
                        panic!("thread content")
                    };
                    let sessions = s.sessions.clone();
                    view.update(cx, |view, cx| {
                        view.shell_select(sessions, selected, cx);
                        cx.notify();
                    });
                    cx.notify();
                });
                draw(&mut visual);
                let badge = visual.debug_bounds("thread-header-worktree-badge");
                assert_eq!(
                    badge.is_some(),
                    expected,
                    "flag={flag:?}, branch={branch:?}, empty={empty}, width={width}"
                );
                assert!(
                    visual.debug_bounds("thread-worktree-badge").is_none(),
                    "the transcript must not render its own badge"
                );
                if let Some(badge) = badge {
                    let header = visual.debug_bounds("thread-header").expect("shell header");
                    let title = visual
                        .debug_bounds("surface-tab-0")
                        .expect("thread title pill");
                    let transcript = visual.debug_bounds("conversation-column").unwrap();
                    assert!(
                        header.contains(&badge.origin) && header.contains(&badge.bottom_right())
                    );
                    assert_eq!(badge.size.height, title.size.height);
                    assert_eq!(badge.center().y, title.center().y);
                    assert!(badge.left() >= title.right());
                    assert!(badge.left() - title.right() <= px(4.));
                    assert!(badge.bottom() <= transcript.top());
                }
            }
        }
        assert!(visual.simulate_close());
    }
}
