//! Portable headless workload through the production Surface and platform input.
use super::*;
use gpui::{TestAppContext, VisualTestContext};
use std::time::Duration;

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}
fn ready(view: &gpui::Entity<Surface>, id: &str, cx: &mut VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        draw(cx);
        if view.read_with(cx, |s, _| {
            s.queue_ready
                && s.transcript
                    .as_ref()
                    .is_some_and(|t| t.key == format!("llm-chat:{id}"))
                && !s.rows.is_empty()
                && !s.painted_rows.borrow().is_empty()
        }) {
            return;
        }
        assert!(Instant::now() < deadline, "fixture selection timed out");
    }
}

#[gpui::test]
#[ignore = "Run only through scripts/next/speed-receipt.mjs with its owned route host"]
fn paired_speed_receipt(cx: &mut TestAppContext) {
    let origin = std::env::var("O8_NEXT_SPEED_SERVER").expect("owned fixture origin");
    let output = std::env::var("O8_NEXT_SPEED_OUTPUT").expect("owned receipt path");
    let client = Client::new(&origin).unwrap();
    let ids = ["thoughts-composer-first", "thoughts-composer-second"];
    let fixture_entries: Vec<_> = ids
        .iter()
        .map(|id| {
            client
                .history(id)
                .unwrap()
                .transcript
                .into_iter()
                .map(|e| json!({"id":e.id,"role":e.role,"text":e.text}))
                .collect::<Vec<_>>()
        })
        .collect();
    let sessions = client.sessions().unwrap();
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut s = Surface::new(client, window, cx);
        s.sessions = sessions;
        s.select(ids[1].into(), cx);
        s
    });
    ready(&view, ids[1], cx);
    let mut switches = vec![];
    for index in 0..10 {
        let id = ids[index % 2];
        let start = Instant::now();
        view.update_in(cx, |s, _, cx| {
            s.painted_rows.borrow_mut().clear();
            s.select(id.into(), cx);
        });
        ready(&view, id, cx);
        view.read_with(cx, |s, _| {
            assert!(
                !s.painted_rows.borrow().is_empty(),
                "selected content must paint"
            )
        });
        switches.push(start.elapsed().as_secs_f64() * 1000.);
    }
    let mut scrolls = vec![];
    for index in 0..50 {
        let target = view.read_with(cx, |s, _| if index % 2 == 0 { s.rows.len() - 1 } else { 0 });
        view.update_in(cx, |s, _, cx| {
            s.painted_rows.borrow_mut().clear();
            s.list.scroll_to(ListOffset {
                item_ix: target,
                offset_in_item: px(0.),
            });
            cx.notify();
        });
        let start = Instant::now();
        draw(cx);
        scrolls.push(start.elapsed().as_secs_f64() * 1000.);
        view.read_with(cx, |s, _| {
            assert!(
                s.painted_rows.borrow().contains(&target),
                "scroll target must paint"
            )
        });
    }
    view.update_in(cx, |s, window, cx| s.composer.read(cx).focus.focus(window));
    draw(cx);
    let mut keys = vec![];
    for count in 1..=20 {
        let start = Instant::now();
        cx.simulate_keystrokes("a");
        draw(cx);
        let elapsed = start.elapsed().as_secs_f64() * 1000.;
        view.read_with(cx, |s, cx| {
            let input = s.composer.read(cx);
            assert_eq!(input.text, "a".repeat(count));
            assert_eq!(input.painted, input.revision, "changed composer must paint");
        });
        keys.push(elapsed);
    }
    let result = json!({"fixtureEntries":fixture_entries,"keyToFrameMs":keys,"scrollFrameMs":scrolls,
        "sidebarSwitchToFirstFrameMs":switches,"idleMemoryMiB":rss(),"offscreen":true,
        "composerPaintAcknowledged":true,"sessionContentPaintAcknowledged":true,"release":!cfg!(debug_assertions)});
    fs::write(output, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
}
