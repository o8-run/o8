use super::*;
use gpui::TestAppContext;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Stdio},
};

struct Host(Child);
impl Drop for Host {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.0.id().to_string()])
            .status();
        let _ = self.0.wait();
    }
}
fn fixture() -> (Host, Client) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("node")
        .current_dir(root)
        .args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "scripts/next/dev-server.ts",
            "--transcript",
        ])
        .env("O8_NEXT_API_TOKEN", "fixture-transcript-bearer")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let origin = lines
        .find_map(|line| {
            serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                .as_str()
                .map(str::to_owned)
        })
        .expect("fixture origin");
    std::thread::spawn(move || for _ in lines {});
    (
        Host(child),
        Client::authenticated(&origin, Some("fixture-transcript-bearer".into())).unwrap(),
    )
}

#[gpui::test]
fn system_events_are_compact_and_expand_on_click(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| s.load_sessions(cx));
    cx.run_until_parked();
    view.update(cx, |s, cx| s.select("thoughts-rich".into(), cx));
    cx.run_until_parked();
    for (index, summary, detail) in [
        (1, "Handed off to destination-model", "intent: full"),
        (
            2,
            "Context compacted · context 100k → 12k tokens",
            "Retained decisions and next steps.",
        ),
    ] {
        view.update(cx, |s, cx| {
            s.list.scroll_to(ListOffset {
                item_ix: index,
                offset_in_item: px(0.),
            });
            cx.notify();
        });
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        let row = view.read_with(cx, |s, _| s.rows[index].clone());
        let (height, lines) = row.borrow().rendered();
        println!(
            "system event {index}: height={}px lines={lines:?}",
            f32::from(height)
        );
        assert_eq!(
            lines.len(),
            1,
            "default event must be one summary row without raw fields"
        );
        assert!(lines[0].contains(summary), "summary: {:?}", lines[0]);
        let bounds = view.read_with(cx, |s, _| s.list.bounds_for_item(index).unwrap());
        cx.simulate_click(bounds.center(), gpui::Modifiers::default());
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        let (expanded, lines) = row.borrow().rendered();
        assert!(expanded > height, "expansion must remeasure the list row");
        assert!(
            lines.iter().any(|line| line.contains(detail)),
            "expanded fields: {lines:?}"
        );
        // Collapse through the same summary control after the list has remeasured.
        let bounds = view.read_with(cx, |s, _| s.list.bounds_for_item(index).unwrap());
        cx.simulate_click(
            gpui::point(bounds.left() + px(30.), bounds.top() + px(16.)),
            gpui::Modifiers::default(),
        );
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        assert_eq!(row.borrow().rendered().0, height);
        cx.simulate_keystrokes("enter");
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        assert!(
            row.borrow().rendered().0 > height,
            "focused summary must expand with Enter"
        );
        cx.simulate_keystrokes("space");
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        assert_eq!(
            row.borrow().rendered().0,
            height,
            "Space collapses the focused summary"
        );
        let viewport = cx.update(|window, _| window.viewport_size());
        cx.simulate_resize(gpui::size(px(440.), px(500.)));
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        let (narrow_height, narrow_lines) = row.borrow().rendered();
        assert_eq!(
            narrow_height, height,
            "narrow summaries must truncate rather than wrap"
        );
        assert_eq!(narrow_lines.len(), 1);
        cx.simulate_resize(viewport);
    }
}

#[gpui::test]
fn persisted_workers_rich_events_and_older_history(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let saved = client.clone();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| s.load_sessions(cx));
    cx.run_until_parked();
    assert!(
        view.read_with(cx, |s, _| s
            .sessions
            .iter()
            .any(|s| s.id == "opencode-owned:next-worker")),
        "runtime workers must appear beside orchestrator threads"
    );
    view.update(cx, |s, cx| {
        s.select("opencode-owned:next-worker".into(), cx)
    });
    cx.run_until_parked();
    view.read_with(cx, |s, _| {
        assert!(s.transcript.is_some(), "worker history: {}", s.notice)
    });
    assert!(view.read_with(cx, |s, _| {
        serde_json::to_string(&s.transcript.as_ref().unwrap().rows)
            .unwrap()
            .contains("Worker history reached GPUI.")
    }));
    assert!(
        !view.read_with(cx, |s, _| s.queue_ready),
        "workers remain read-only"
    );
    assert!(view.read_with(cx, |s, _| matches!(&s.rows[0].borrow().row, Row::PacketHeader { details: Some(header), .. } if header["title"] == "Worker packet header")), "packet metadata must come from the existing mission-state payload");
    view.update(cx, |s, cx| s.select("thoughts-rich".into(), cx));
    cx.run_until_parked();
    let tree = view.read_with(cx, |s, _| {
        serde_json::to_value(&s.transcript.as_ref().unwrap().rows).unwrap()
    });
    let history = saved.history("thoughts-rich").unwrap();
    let expected: Value = serde_json::from_str(include_str!("../fixtures/rich.tree.json")).unwrap();
    assert_eq!(
        tree, expected,
        "GPUI must consume the recorded production WebKit render tree"
    );
    assert_eq!(
        serde_json::to_value(crate::model::render_tree(&history.transcript)).unwrap(),
        expected
    );
    for kind in [
        "packet-header",
        "handoff",
        "compaction",
        "table",
        "diff-card",
        "media",
    ] {
        assert!(tree.to_string().contains(kind), "missing rich kind {kind}");
    }
    for index in 0..6 {
        view.update(cx, |s, cx| {
            s.painted_rows.borrow_mut().clear();
            s.list.scroll_to(ListOffset {
                item_ix: index,
                offset_in_item: px(0.),
            });
            cx.notify();
        });
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        assert!(
            view.read_with(cx, |s, _| s.painted_rows.borrow().contains(&index)),
            "rich row {index} must reach paint"
        );
    }
    view.update(cx, |s, cx| s.select("thoughts-pagination".into(), cx));
    cx.run_until_parked();
    let retained = view.read_with(cx, |s, _| s.rows[0].clone());
    let layouts = retained.borrow().layouts;
    assert!(
        cx.debug_bounds("load-older").is_none(),
        "scroll is the default"
    );
    view.update(cx, |s, cx| {
        s.list.scroll_to(ListOffset {
            item_ix: 0,
            offset_in_item: px(241.),
        });
        s.on_transcript_scroll(cx);
        assert!(!s.history_loading, "outside classic's 240 px threshold");
        cx.notify();
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    let viewport = view.read_with(cx, |s, _| s.list.viewport_bounds());
    cx.simulate_event(gpui::ScrollWheelEvent {
        position: viewport.center(),
        delta: gpui::ScrollDelta::Pixels(gpui::point(px(0.), px(1.))),
        ..Default::default()
    });
    cx.run_until_parked();
    view.read_with(cx, |s, _| {
        assert_eq!(s.transcript.as_ref().unwrap().entries.len(), 200);
        assert!(Rc::ptr_eq(&retained, &s.rows[100]));
        assert_eq!(
            retained.borrow().layouts,
            layouts,
            "backfill must retain shaped rows"
        );
    });
    std::thread::sleep(std::time::Duration::from_millis(80));
    view.update(cx, |s, cx| {
        s.poll_stream(cx);
    });
    assert!(
        view.read_with(cx, |s, _| s.transcript.as_ref().unwrap().page.is_some()),
        "real bootstrap checkpoint must keep older-history reachable"
    );
}

#[gpui::test]
fn history_backfill_is_single_flight_and_preserves_the_completion_time_anchor(
    cx: &mut TestAppContext,
) {
    let (_host, client) = fixture();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| s.load_sessions(cx));
    cx.run_until_parked();
    view.update(cx, |s, cx| s.select("thoughts-pagination".into(), cx));
    cx.run_until_parked();
    let anchor = view.update(cx, |s, cx| {
        s.list.scroll_to(ListOffset {
            item_ix: 0,
            offset_in_item: px(240.),
        });
        s.on_transcript_scroll(cx);
        assert!(s.history_loading, "threshold includes 240 px");
        for _ in 0..5 {
            s.on_transcript_scroll(cx);
            s.load_older(cx);
        }
        // The reader moves before the response completes. Do not restore the
        // position captured when the request began.
        s.list.scroll_to(ListOffset {
            item_ix: 0,
            offset_in_item: px(7.),
        });
        s.rows[0].clone()
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    let before = view.read_with(cx, |s, _| s.list.bounds_for_item(0).unwrap());
    let viewport = view.read_with(cx, |s, _| s.list.viewport_bounds());
    assert!(cx.debug_bounds("load-older").is_some(), "pending fallback");
    cx.run_until_parked();
    view.read_with(cx, |s, _| {
        assert!(!s.history_loading);
        assert_eq!(
            s.transcript.as_ref().unwrap().entries.len(),
            200,
            "repeated scrolls must fetch just one older page"
        );
        let top = s.list.logical_scroll_top();
        assert_eq!(top.item_ix, 100);
        assert_eq!(top.offset_in_item, px(7.));
        assert!(Rc::ptr_eq(&anchor, &s.rows[top.item_ix]));
        assert_eq!(
            s.list.bounds_for_item(top.item_ix).unwrap().top(),
            before.top()
        );
        assert_eq!(
            s.list.viewport_bounds(),
            viewport,
            "fallback must not shift the viewport"
        );
    });
    // GPUI retains removed debug selectors across frames; check current state
    // rather than using an old selector's cached bounds to infer visibility.
    view.read_with(cx, |s, _| {
        assert!(!s.history_loading && s.history_error.is_none())
    });
    view.update(cx, |s, cx| {
        s.on_transcript_scroll(cx);
        assert!(
            !s.history_loading,
            "prepended rows must count toward distance to the top"
        );
        s.transcript
            .as_mut()
            .unwrap()
            .page
            .as_mut()
            .unwrap()
            .has_more = false;
        s.list.scroll_to(ListOffset {
            item_ix: 0,
            offset_in_item: px(0.),
        });
        s.on_transcript_scroll(cx);
        assert!(!s.history_loading, "exhausted history must not load");
    });
}

#[gpui::test]
fn history_failure_waits_for_the_fallback_retry(cx: &mut TestAppContext) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let client = Client::authenticated(&origin, None).unwrap();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| {
        s.selected = Some("thoughts-failed".into());
        s.transcript = Some(Transcript::new(
            serde_json::from_value(json!({
                "sessionKey":"llm-chat:thoughts-failed",
                "transcript":[{"id":"tail","role":"assistant","text":"Tail"}],
                "page":{"hasMore":true,"beforeCursor":"older"}
            }))
            .unwrap(),
        ));
        s.install_rows(s.transcript.as_ref().unwrap().rows.clone(), cx);
        s.on_transcript_scroll(cx);
    });
    cx.run_until_parked();
    view.update(cx, |s, cx| {
        assert!(s.history_error.is_some());
        assert!(!s.history_loading);
        s.on_transcript_scroll(cx);
        assert!(!s.history_loading, "scroll must not spin on a failed page");
        s.history_error = Some("retry sentinel".into());
        cx.notify();
    });
    cx.run_until_parked();
    let retry = cx.debug_bounds("load-older").expect("failed-load fallback");
    cx.simulate_click(retry.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    view.read_with(cx, |s, _| {
        assert_ne!(
            s.history_error.as_deref(),
            Some("retry sentinel"),
            "the fallback must retry the existing cursor even when failure completes immediately"
        );
    });
}

/// The same first-draw/key-paint endpoints as the existing harness. Linux's
/// TestAppContext uses a no-op text system: these receipts measure test scenes,
/// and cannot substitute for the macOS font-shaping/GPU acceptance measurements.
#[gpui::test]
#[ignore]
fn transcript_2000_rows_20hz_measurement(cx: &mut TestAppContext) {
    let (_host, client) = fixture();
    let started = Instant::now();
    let (view, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    view.update(cx, |s, cx| s.load_sessions(cx));
    cx.run_until_parked();
    view.update(cx, |s, cx| s.select("thoughts-pagination".into(), cx));
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |s, cx| {
            s.list.scroll_to(ListOffset {
                item_ix: 0,
                offset_in_item: px(0.),
            });
            s.painted_rows.borrow_mut().clear();
            cx.notify();
        });
        window.refresh();
        window.draw(cx).clear();
        window.refresh();
        window.draw(cx).clear();
    });
    assert!(
        view.read_with(cx, |s, _| s.painted_rows.borrow().contains(&0)),
        "first content scene must paint before launch timing ends: {}",
        view.read_with(cx, |s, _| format!(
            "{} rows; painted {:?}; {}",
            s.rows.len(),
            s.painted_rows.borrow(),
            s.notice
        ))
    );
    let first = started.elapsed().as_secs_f64() * 1000.;
    for _ in 0..19 {
        view.update(cx, |s, cx| s.load_older(cx));
        cx.run_until_parked();
    }
    assert_eq!(view.read_with(cx, |s, _| s.rows.len()), 2000);
    let memory = rss();
    let mut scroll = Vec::new();
    for index in 0..50 {
        cx.update(|window, cx| {
            view.update(cx, |s, cx| {
                s.list.scroll_to(ListOffset {
                    item_ix: if index % 2 == 0 { 0 } else { 1999 },
                    offset_in_item: px(0.),
                });
                s.painted_rows.borrow_mut().clear();
                cx.notify();
            });
            let start = Instant::now();
            window.refresh();
            window.draw(cx).clear();
            scroll.push(start.elapsed().as_secs_f64() * 1000.);
            assert!(
                view.read(cx)
                    .painted_rows
                    .borrow()
                    .contains(&(if index % 2 == 0 { 0 } else { 1999 })),
                "scroll target must paint in its first draw"
            );
        });
    }
    let mut frames = Vec::new();
    let mut keys = Vec::new();
    let mut unchanged = 0;
    let deadline = Instant::now() + std::time::Duration::from_secs(9);
    while Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
        let before = view.read_with(cx, |s, _| {
            s.rows
                .iter()
                .map(|state| {
                    (
                        state.borrow().row.id().to_owned(),
                        (state.clone(), state.borrow().layouts),
                    )
                })
                .collect::<HashMap<_, _>>()
        });
        let changed = view.update(cx, |s, cx| s.poll_stream(cx));
        if changed {
            let start = Instant::now();
            cx.update(|window, cx| {
                if keys.len() < 20 {
                    window.dispatch_keystroke(Keystroke::parse("end").unwrap(), cx);
                }
                view.update(cx, |s, cx| {
                    s.list.scroll_to(ListOffset {
                        item_ix: 1999,
                        offset_in_item: px(0.),
                    });
                    s.painted_rows.borrow_mut().clear();
                    cx.notify();
                });
                let draw = Instant::now();
                window.refresh();
                window.draw(cx).clear();
                assert_eq!(
                    view.read(cx).painted.get(),
                    view.read(cx).key_revision,
                    "streaming key revision must reach paint"
                );
                frames.push(draw.elapsed().as_secs_f64() * 1000.);
                window.refresh();
                window.draw(cx).clear();
            });
            if keys.len() < 20 {
                keys.push(start.elapsed().as_secs_f64() * 1000.);
            }
            view.read_with(cx, |s, _| {
                assert!(
                    s.painted_rows.borrow().contains(&1999),
                    "changed tail must paint"
                );
                assert_eq!(
                    s.rows.len(),
                    2000,
                    "stream windows must preserve backfilled history"
                );
                for state in s.rows.iter().take(1999) {
                    if let Some((old, layouts)) = before.get(state.borrow().row.id()) {
                        assert!(Rc::ptr_eq(old, state));
                        unchanged += state.borrow().layouts - layouts;
                    }
                }
            });
        }
        if view.read_with(cx, |s, _| s.transcript.as_ref().unwrap().seq >= 120) {
            break;
        }
    }
    assert!(frames.len() >= 60, "enough distinct 20 Hz stream paints");
    assert_eq!(keys.len(), 20);
    assert_eq!(unchanged, 0);
    assert_eq!(
        view.read_with(cx, |s, _| s.transcript.as_ref().unwrap().seq),
        120,
        "measurement must reach the final wire revision"
    );
    println!(
        "O8_NEXT_TRANSCRIPT_EVIDENCE {}",
        json!({"endpoint":"Linux GPUI TestAppContext CPU scene; no-op text system; no GPU presentation", "rows":2000,"cadenceHz":20,"streamFrameMs":frames,"scrollFrameMs":scroll,"keyToFrameMs":keys,"idleRssMiB":memory,"launchToFirstFrameMs":first,"unchangedRowRelayouts":unchanged,"lastSeq":120,"streamTailPaintAcknowledged":true})
    );
}
