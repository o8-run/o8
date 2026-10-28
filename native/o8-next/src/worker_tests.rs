use super::*;
use std::{io::Write, time::Duration};

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

fn wait(
    server: &mut Server,
    surface: &gpui::Entity<Surface>,
    cx: &mut gpui::VisualTestContext,
    label: &str,
    check: impl Fn(&Surface) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(35);
    let mut reconciled = Instant::now();
    loop {
        // Same cadence and production method as the launcher's existing tick.
        if reconciled.elapsed() >= Duration::from_secs(1) {
            surface.update(cx, |s, cx| s.reconcile(cx));
            reconciled = Instant::now();
        }
        cx.run_until_parked();
        surface.update(cx, |s, cx| {
            s.poll_stream(cx);
        });
        draw(cx);
        if surface.read_with(cx, |s, _| check(s)) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "fixture timed out: {label}; {:?}\n{}",
            surface.read_with(cx, |s, _| (
                s.notice.clone(),
                s.transcript.as_ref().map(|t| t.seq),
                s.rows.len(),
                s.queue["items"].as_array().map(|items| items
                    .iter()
                    .map(|i| (i["status"].clone(), i["reason"].clone()))
                    .collect::<Vec<_>>())
            )),
            server.diagnostics()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn contains(surface: &Surface, text: &str) -> bool {
    surface
        .transcript
        .as_ref()
        .is_some_and(|t| t.entries.iter().any(|e| e.text.contains(text)))
}
fn worker_text(surface: &Surface) -> String {
    surface
        .transcript
        .as_ref()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.role == "assistant" && e.text.contains("Worker streaming"))
        .map(|e| e.text.clone())
        .unwrap_or_default()
}

#[gpui::test]
fn worker_send_steer_queue_promote_remove_and_streaming_latency(cx: &mut TestAppContext) {
    let (mut server, client) = fixture_mode(true);
    let saved = client.clone();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, cx| {
        s.sessions = saved.sessions().unwrap();
        s.select("thoughts-composer-first".into(), cx);
    });
    wait(&mut server, &surface, cx, "initial queue receipt", |s| {
        s.queue_ready
    });
    assert!(
        cx.debug_bounds("send-mode-steer").is_some(),
        "render the default Steer chip"
    );
    surface.update_in(cx, |s, window, cx| s.composer.read(cx).focus.focus(window));
    // GPUI installs the native input handler during paint after focus changes.
    draw(cx);
    cx.simulate_input("Start streaming");
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "Start streaming",
        "native input must reach the focused composer before Enter"
    );
    draw(cx);
    let start = Instant::now();
    cx.simulate_keystrokes("enter");
    wait(&mut server, &surface, cx, "first worker transcript", |s| {
        contains(s, "Worker streaming")
    });
    let send_ms = start.elapsed().as_secs_f64() * 1000.;
    surface.read_with(cx, |s, _| {
        assert!(
            s.painted_rows.borrow().contains(&(s.rows.len() - 1)),
            "worker reply must paint before timing ends"
        );
    });
    let first = surface.read_with(cx, |s, _| worker_text(s).len());
    let mut keys = vec![];
    for _ in 0..30 {
        let text = surface.read_with(cx, |s, _| worker_text(s));
        wait(&mut server, &surface, cx, "advancing worker stream", |s| {
            worker_text(s) != text
        });
        let start = Instant::now();
        cx.simulate_input("a");
        draw(cx);
        surface.read_with(cx, |s, cx| {
            let input = s.composer.read(cx);
            assert_eq!(
                input.painted, input.revision,
                "changed input reaches CPU scene paint"
            );
        });
        keys.push(start.elapsed().as_secs_f64() * 1000.);
    }
    let streamed_bytes = surface.read_with(cx, |s, _| worker_text(s).len());
    assert!(streamed_bytes > first);
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Steered instruction");
    cx.simulate_keystrokes("enter");
    wait(&mut server, &surface, cx, "steer receipt", |s| {
        contains(s, "Steered instruction")
    });
    assert_eq!(
        surface.read_with(cx, |s, _| s.queue["items"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["intent"]
            .clone()),
        "steer-now"
    );
    cx.simulate_keystrokes("ctrl-shift-enter");
    draw(cx);
    assert!(cx.debug_bounds("send-mode-queue").is_some());
    cx.simulate_input("Promoted instruction");
    cx.simulate_keystrokes("enter");
    wait(&mut server, &surface, cx, "queued promote receipt", |s| {
        s.queue["items"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["payload"]["text"] == "Promoted instruction" && item["status"] == "queued"
            })
        })
    });
    let promote = cx
        .debug_bounds("steer-now")
        .expect("queued steer now action");
    assert!(
        cx.debug_bounds("remove-queued").is_some(),
        "queued remove action"
    );
    cx.simulate_click(promote.center(), gpui::Modifiers::default());
    wait(&mut server, &surface, cx, "promoted receipt", |s| {
        contains(s, "Promoted instruction")
    });
    surface.update_in(cx, |s, window, cx| s.composer.read(cx).focus.focus(window));
    draw(cx);
    cx.simulate_input("Removed instruction");
    draw(cx);
    cx.simulate_keystrokes("enter");
    wait(&mut server, &surface, cx, "queued remove receipt", |s| {
        s.queue["items"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["payload"]["text"] == "Removed instruction" && item["status"] == "queued"
            })
        })
    });
    cx.simulate_input("Draft kept");
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "Draft kept"
    );
    draw(cx);
    let remove = cx.debug_bounds("remove-queued").unwrap();
    cx.simulate_click(remove.center(), gpui::Modifiers::default());
    wait(&mut server, &surface, cx, "removed queue receipt", |s| {
        s.queue["items"].as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| item["payload"]["text"] != "Removed instruction")
        })
    });
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "Draft kept"
    );
    surface.update_in(cx, |s, window, cx| s.composer.read(cx).focus.focus(window));
    draw(cx);
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Queued instruction");
    draw(cx);
    cx.simulate_keystrokes("enter");
    wait(
        &mut server,
        &surface,
        cx,
        "persisted queued instruction",
        |s| {
            s.queue["items"].as_array().is_some_and(|items| {
                items.iter().any(|item| {
                    item["payload"]["text"] == "Queued instruction" && item["status"] == "queued"
                })
            })
        },
    );
    assert!(
        !surface.read_with(cx, |s, _| contains(s, "Queued instruction")),
        "queue waits for active turn"
    );
    assert_eq!(
        surface.read_with(cx, |s, _| s.queue["items"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["status"]
            .clone()),
        "queued"
    );
    server
        .0
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"release\n")
        .unwrap();
    wait(&mut server, &surface, cx, "queued worker result", |s| {
        contains(s, "Worker received: Queued instruction")
    });
    wait(
        &mut server,
        &surface,
        cx,
        "completed worker steering receipt",
        |s| {
            s.transcript.as_ref().unwrap().entries.iter().any(|e| {
                e.role == "assistant"
                    && e.text.contains("Steered instruction")
                    && e.text.contains("Promoted instruction")
            })
        },
    );
    assert!(surface.read_with(cx, |s, _| {
        s.transcript.as_ref().unwrap().entries.iter().any(|e| {
            e.role == "assistant"
                && e.text.contains("Steered instruction")
                && e.text.contains("Promoted instruction")
        })
    }));
    assert!(!surface.read_with(cx, |s, _| contains(s, "Removed instruction")));
    let result = json!({"endpoint":"Linux GPUI TestAppContext CPU scene paint; no GPU presentation; no-op text system", "release":!cfg!(debug_assertions),
        "keyToFrameWhileStreamingMs":keys, "sendToFirstWorkerTranscriptPaintMs":send_ms,
        "workerTextBytesBefore":first,"workerTextBytesAfter":streamed_bytes});
    if let Ok(path) = std::env::var("O8_NEXT_WORKER_RESULTS") {
        fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    }
    println!("O8_NEXT_WORKER_EVIDENCE {result}");
}
