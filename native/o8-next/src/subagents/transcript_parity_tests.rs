//! The production chat and the Subagents right-panel component paint one fixture.
use super::*;
use crate::subagents::{
    Inspector,
    model::{Agent, Facts, Group, Scope},
};
use gpui::{Entity, Modifiers, VisualTestContext};
use std::time::Duration;

struct Panel(Entity<Inspector>);
impl Render for Panel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().flex().flex_col().child(self.0.clone())
    }
}
fn agent(session: Option<String>, failed: bool) -> Agent {
    Agent {
        shared: false,
        native: true,
        cleanup: None,
        prompt: None,
        run: "parity".into(),
        id: "parity".into(),
        title: "Reviewer".into(),
        runtime: "codex".into(),
        model: None,
        effort: None,
        parent: None,
        session,
        group: if failed {
            Group::Attention
        } else {
            Group::Done
        },
        status: if failed { "Failed" } else { "Done" }.into(),
        progress: failed.then(|| "The runtime exited before producing a turn.".into()),
        result: None,
        started: None,
        finished: None,
        facts: Facts::default(),
    }
}
fn paint(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}
fn wait(cx: &mut VisualTestContext, selector: &'static str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        paint(cx);
        if cx.debug_bounds(selector).is_some() {
            return;
        }
        assert!(Instant::now() < deadline, "missing painted row: {selector}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn structure(cx: &mut VisualTestContext) -> Vec<(String, gpui::Size<gpui::Pixels>)> {
    paint(cx);
    let prompt = cx.debug_bounds("transcript-row-0").unwrap();
    cx.simulate_mouse_move(prompt.center(), None, Modifiers::default());
    paint(cx);
    [
        "transcript-row-0",
        "transcript-row-1",
        "transcript-row-2",
        "trace-header-1",
        "transcript-verdict-2",
        "message-actions-2",
        "message-play-2",
        "message-copy-2",
        "prompt-copy-parity-prompt",
        "prompt-rewind-parity-prompt",
        "prompt-fork-parity-prompt",
        "turn-files-2",
    ]
    .into_iter()
    .map(|selector| {
        (
            selector.into(),
            cx.debug_bounds(selector)
                .unwrap_or_else(|| panic!("missing shared transcript element: {selector}"))
                .size,
        )
    })
    .collect()
}

#[gpui::test]
fn main_and_subagents_panel_render_identical_transcript_rows(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let sessions = client.sessions().unwrap();
    let session = sessions
        .iter()
        .find(|s| s.id == "thoughts-composer-first")
        .unwrap()
        .clone();
    client.request("POST", &client.url("/api/v2/chat-history").unwrap()).send_json(json!({
        "tabId":session.id, "repoPath":session.repo_path, "backend":"pi", "model":"pi", "replace":true,
        "messages":[
            {"id":"parity-prompt","role":"user","content":"Review **this patch**.","timestamp":1000},
            {"id":"parity-tool","role":"assistant","content":"","timestamp":2000,"toolCalls":[
                {"id":"edit","name":"Edit","args":{"file_path":"src/parity.ts","old_string":"old","new_string":"new"},"status":"completed","result":"Updated"}]},
            {"id":"parity-answer","role":"assistant","content":"## Review\n\nThe patch is ready.\n\n- Tests passed.","timestamp":3000}
        ]
    })).unwrap();
    let (main, main_cx) = cx.add_window_view(|window, cx| {
        Surface::shell_new(client.clone(), sessions, session.id.clone(), window, cx)
    });
    let width = crate::theme::GEOMETRY.right_width;
    // Main reserves its chrome inset and the existing adjacent column gap.
    main_cx.simulate_resize(size(
        px(width + 2. * crate::theme::GEOMETRY.inset + crate::theme::GEOMETRY.gap),
        px(1000.),
    ));
    wait(main_cx, "transcript-verdict-2");
    let expected = structure(main_cx);
    assert_eq!(expected[0].1.width, px(width));
    // Keep the main view alive while mounting the actual right-panel Inspector.
    assert!(main.read_with(main_cx, |s, _| s.transcript.is_some()));
    let (panel, panel_cx) = main_cx.cx.add_window_view(|window, cx| {
        let inspector = cx.new(|cx| {
            Inspector::new(
                client.clone(),
                Scope {
                    repo: session.repo_path.clone().unwrap_or_default(),
                    parent: None,
                },
                cx,
            )
        });
        inspector.update(cx, |s, cx| {
            s.set_native(
                vec![agent(Some(format!("llm-chat:{}", session.id)), false)],
                cx,
            );
            s.inspect(Some("parity".into()), window, cx);
        });
        Panel(inspector)
    });
    panel_cx.simulate_resize(size(px(width), px(1000.)));
    wait(panel_cx, "transcript-verdict-2");
    assert_eq!(
        structure(panel_cx),
        expected,
        "same components and row dimensions at panel width"
    );
    let copy = panel_cx.debug_bounds("prompt-copy-parity-prompt").unwrap();
    panel_cx.simulate_click(copy.center(), Modifiers::default());
    assert_eq!(
        panel_cx.read_from_clipboard().unwrap().text().unwrap(),
        "Review **this patch**."
    );
    let header = panel_cx.debug_bounds("trace-header-1").unwrap();
    panel_cx.simulate_click(header.center(), Modifiers::default());
    paint(panel_cx);
    assert!(
        panel_cx.debug_bounds("trace-line-1-0").is_some(),
        "shared tool disclosure opens"
    );
    assert!(
        panel
            .read_with(panel_cx, |p, _| p.0.clone())
            .read_with(panel_cx, |s, _| s.open)
    );
}

#[gpui::test]
fn failed_subagent_without_turns_uses_the_shared_trace_state(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let (_panel, cx) = cx.add_window_view(|window, cx| {
        let inspector = cx.new(|cx| {
            Inspector::new(
                client.clone(),
                Scope {
                    repo: "/repo".into(),
                    parent: None,
                },
                cx,
            )
        });
        inspector.update(cx, |s, cx| {
            s.set_native(vec![agent(None, true)], cx);
            s.inspect(Some("parity".into()), window, cx);
        });
        Panel(inspector)
    });
    cx.simulate_resize(size(px(320.), px(620.)));
    paint(cx);
    assert!(
        cx.debug_bounds("trace-header-0").is_some(),
        "failed task without turns must render its state and reason through the shared trace row"
    );
    assert!(cx.debug_bounds("transcript-row-0").is_some());
    assert!(
        cx.debug_bounds("transcript-row-1").is_some(),
        "the failure reason is a wrapping shared system-message row"
    );
}
