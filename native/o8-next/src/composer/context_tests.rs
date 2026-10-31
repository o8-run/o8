use super::*;

fn entry(value: Value) -> Entry {
    serde_json::from_value(value).unwrap()
}
fn turn(tokens: Value) -> Entry {
    entry(json!({"id":"a", "role":"assistant", "text":"", "tokens":tokens}))
}
fn observation(
    session: &str,
    start: f64,
    end: f64,
    read: Option<f64>,
    ttl: Option<f64>,
) -> Observation {
    Observation {
        id: format!("{session}-{start}"),
        session: session.into(),
        runtime: "codex".into(),
        model: "fixture".into(),
        start,
        end,
        input: Some(100.),
        read,
        write: Some(0.),
        ttl,
        idle: None,
    }
}

#[test]
fn projection_keeps_runtime_parent_context_authoritative() {
    assert_eq!(
        project(43_700., 4_000.),
        Projection {
            reported: true,
            active: 43_700.,
            conversation: 4_000.,
            other: 28_100.
        }
    );
    assert_eq!(
        project(0., 4_000.),
        Projection {
            reported: false,
            active: 15_600.,
            conversation: 4_000.,
            other: 0.
        }
    );
    assert_eq!(SYSTEM + TOOLS, 11_600.);
    assert_eq!(project(100., 4_000.).active, 100.);
    assert_eq!(project(100., 4_000.).other, 0.);
}

#[test]
fn projection_sanitizes_counts_and_clamps_only_the_ring() {
    assert_eq!(project(f64::NAN, f64::INFINITY), project(0., 0.));
    assert_eq!(project(-1., -2.), project(0., 0.));
    assert_eq!(project(43_700.9, 4_000.9), project(43_700., 4_000.));
    assert_eq!(project(2_000_000., 0.).percent(), 100.);
    assert_eq!(project(2_000_000., 0.).active, 2_000_000.);
}

#[test]
fn visible_residency_uses_content_never_summed_billing_input() {
    let rows = vec![
        entry(json!({"id":"u", "role":"user", "text":"  12345  ", "tokens":{"input":900000}})),
        entry(
            json!({"id":"a", "role":"assistant", "text":"😀😀😀", "thinking":"abcdefgh", "toolCalls":[{"name":"tool", "args":"12345", "preview":"1234", "result":{"ok":true}}], "tokens":{"input":900000}}),
        ),
        entry(json!({"id":"empty", "role":"assistant", "text":""})),
        entry(
            json!({"id":"compact", "role":"assistant", "text":"ignored", "compaction":{"tokensAfter":100}}),
        ),
    ];
    // UTF-16 / 4, ceiling per field, a minimum of one per transcript row.
    assert_eq!(
        conversation(&rows),
        2. + (2. + 2. + 1. + 2. + 1. + 3.) + 1. + 100.
    );
}

#[test]
fn reuse_uses_last_reported_prompt_excludes_output_and_prior_turns() {
    let reuse = latest_reuse(&[
        turn(json!({"input":10,"output":0,"cacheRead":90})),
        turn(json!({"input":200,"output":4000,"cacheRead":800,"cacheWrite":0})),
    ]);
    assert_eq!(
        reuse,
        Some(Reuse {
            prompt: 1000.,
            read: 800.,
            write: 0.,
            percent: 80.
        })
    );
    assert_eq!(
        latest_reuse(&[turn(json!({"input":100,"output":5,"cacheRead":0}))])
            .unwrap()
            .percent,
        0.
    );
    assert!(latest_reuse(&[turn(json!({"input":100,"output":5}))]).is_none());
    assert!(latest_reuse(&[]).is_none());
    assert_eq!(
        latest_reuse(&[
            turn(json!({"input":200,"cacheRead":800})),
            turn(Value::Null)
        ])
        .unwrap()
        .percent,
        80.
    );
    assert!(latest_reuse(&[turn(json!({"input":0,"cacheRead":0,"cacheWrite":0}))]).is_none());
    assert!(
        latest_reuse(&[
            turn(json!({"input":1,"cacheRead":9})),
            turn(json!({"input":10}))
        ])
        .is_none()
    );
    assert_eq!(
        latest_reuse(&[turn(
            json!({"input":100.9,"cacheRead":50.9,"cacheWrite":50.9})
        )])
        .unwrap(),
        Reuse {
            prompt: 200.,
            read: 50.,
            write: 50.,
            percent: 25.
        }
    );
    assert_eq!(
        latest_reuse(&[turn(json!({"input":100,"cacheRead":-1,"cacheWrite":"bad"}))])
            .unwrap()
            .percent,
        0.
    );
}

#[test]
fn cache_labels_follow_selected_conversation_runtime_and_model() {
    let now = 10_000_000.;
    let rows = [
        observation("warm", now - 660_000., now, Some(900.), Some(300_000.)),
        observation(
            "expired",
            now - 660_000.,
            now - 600_000.,
            Some(900.),
            Some(300_000.),
        ),
    ];
    let status = |session, runtime, model, now| estimate(&rows, session, runtime, model, now);
    let warm = status("warm", "codex", "fixture", now);
    assert_eq!(label("codex", warm.as_ref(), false), "Warm ~5m");
    assert!(
        explanation("codex", warm.as_ref()).contains("Cache warm · about 5 min left · estimate")
    );
    assert_eq!(
        label(
            "codex",
            status("expired", "codex", "fixture", now).as_ref(),
            false
        ),
        "Cold · est."
    );
    assert_eq!(
        label(
            "codex",
            status("unseen", "codex", "fixture", now).as_ref(),
            false
        ),
        "Cache ?"
    );
    assert_eq!(
        label(
            "codex",
            status("warm", "codex", "other-model", now).as_ref(),
            false
        ),
        "Cache ?"
    );
    assert_eq!(label("unavailable", None, false), "Cache n/a");
    assert_eq!(label("claude", None, false), "Cache n/a"); // same runtime identity rule as classic
    assert!(explanation("unavailable", None).contains("unavailable for this runtime"));
    assert!(
        explanation("codex", warm.as_ref())
            .contains("reuse is not guaranteed. No keep-alive requests are sent.")
    );
}

#[test]
fn warmth_uses_existing_clock_and_never_counts_below_zero() {
    let now = 10_000_000.;
    let rows = [observation(
        "warm",
        now - 660_000.,
        now,
        Some(900.),
        Some(300_000.),
    )];
    let after_minute = estimate(&rows, "warm", "codex", "fixture", now + 60_000.).unwrap();
    assert_eq!(label("codex", Some(&after_minute), false), "Warm ~4m");
    // Long estimates read in hours and days, not thousands of minutes.
    let long = |minutes: f64| Estimate {
        remaining: minutes * 60_000.,
        requested: false,
    };
    assert_eq!(label("codex", Some(&long(90.)), false), "Warm ~2h");
    assert_eq!(label("codex", Some(&long(5404.)), false), "Warm ~4d");
    assert_eq!(label("codex", Some(&long(5404.)), true), "~4d");
    assert!(explanation("codex", Some(&long(5404.))).contains("about 4 days left"));
    assert_eq!(label("codex", Some(&after_minute), true), "~4m");
    let expired = estimate(&rows, "warm", "codex", "fixture", now + 360_000.).unwrap();
    assert_eq!(expired.remaining, 0.);
    assert_eq!(label("codex", Some(&expired), false), "Cold · est.");
    assert_eq!(label("codex", Some(&expired), true), "~cold");
    assert_eq!(label("codex", None, true), "?");
    assert_eq!(label("unsupported", None, true), "n/a");
}

#[test]
fn a_turn_without_usage_keeps_the_estimate_from_the_last_reported_turn() {
    let now = 10_000_000.;
    let rows = [
        observation("warm", now - 660_000., now, Some(900.), Some(300_000.)),
        // A failed resume reports no usage at all.
        observation("warm", now + 10_000., now + 20_000., None, None),
    ];
    let status = estimate(&rows, "warm", "codex", "fixture", now + 60_000.);
    assert_eq!(label("codex", status.as_ref(), false), "Warm ~4m");
}

#[test]
fn observed_windows_are_bounded_by_large_cold_resumes_without_inventing_a_ttl() {
    let mut rows = vec![
        observation("a", 0., 1_000., Some(100.), None),
        observation("a", 61_000., 62_000., Some(100.), None),
    ];
    assert_eq!(
        estimate(&rows, "a", "codex", "fixture", 62_000.),
        Some(Estimate {
            remaining: 60_000.,
            requested: false
        })
    );
    let mut cold = observation("a", 152_000., 153_000., Some(0.), None);
    cold.input = Some(10_000.);
    rows.push(cold);
    assert_eq!(
        estimate(&rows, "a", "codex", "fixture", 153_000.)
            .unwrap()
            .remaining,
        0.
    );
    rows.push(observation("a", 253_000., 254_000., Some(100.), None));
    assert_eq!(
        estimate(&rows, "a", "codex", "fixture", 254_000.)
            .unwrap()
            .remaining,
        60_000.
    );
    assert!(
        estimate(
            &[observation("a", 0., 1., Some(100.), None)],
            "a",
            "codex",
            "fixture",
            1.
        )
        .is_none()
    );
    assert!(
        estimate(
            &[observation("a", 0., 1., None, Some(300_000.))],
            "a",
            "codex",
            "fixture",
            1.
        )
        .is_none()
    );
}

#[test]
fn requested_lifetime_overrides_observed_window_and_latest_model_blocks_old_evidence() {
    let rows = [
        observation("a", 0., 1_000., Some(10.), None),
        observation("a", 61_000., 62_000., Some(10.), Some(300_000.)),
    ];
    assert_eq!(
        estimate(&rows, "a", "codex", "fixture", 62_000.),
        Some(Estimate {
            remaining: 300_000.,
            requested: true
        })
    );
    let mut rows = rows.to_vec();
    let mut switched = observation("a", 63_000., 64_000., Some(10.), Some(300_000.));
    switched.model = "other".into();
    rows.push(switched);
    assert!(estimate(&rows, "a", "codex", "fixture", 64_000.).is_none());
}

#[test]
fn observations_keep_missing_counters_unknown_and_preserve_actual_completion_on_reopen() {
    let rows = vec![
        entry(json!({"id":"u","role":"user","text":"go","timestamp":1000})),
        entry(
            json!({"id":"a","role":"assistant","text":"done","timestamp":2000,"model":"fixture","backend":"codex","tokens":{"input":100,"cacheRead":900,"cacheWrite":0,"cacheRetentionMs":300000}}),
        ),
    ];
    assert!(
        observe(
            "observed-fixture",
            "session",
            "codex",
            &rows,
            true,
            None,
            3000.
        )
        .is_empty()
    );
    let saved = observe(
        "observed-fixture",
        "session",
        "codex",
        &rows,
        false,
        Some(3000.),
        3000.,
    );
    assert_eq!(saved[0].end, 3000.);
    assert_eq!(saved[0].read, Some(900.));
    assert_eq!(
        observe(
            "observed-fixture",
            "session",
            "codex",
            &rows,
            false,
            None,
            4000.
        )[0]
        .end,
        3000.
    );
    let mut unknown = rows.clone();
    unknown[1].extra.get_mut("tokens").unwrap()["cacheObserved"] = json!(false);
    assert_eq!(
        observe(
            "unknown-fixture",
            "session",
            "codex",
            &unknown,
            false,
            None,
            4000.
        )[0]
        .read,
        None
    );
    let mut switched = rows.clone();
    switched[1].extra.insert("backend".into(), json!("claude"));
    assert!(
        observe(
            "mixed-fixture",
            "session",
            "codex",
            &switched,
            false,
            None,
            4000.
        )
        .is_empty()
    );
}

#[test]
fn telemetry_never_uses_billing_or_names_a_server_estimate_as_runtime_truth() {
    assert_eq!(
        telemetry(&json!({"telemetry":{"contextTokens":43700,"totalTokens":9999999}})),
        43700.
    );
    assert_eq!(telemetry(&json!({"telemetry":{"totalTokens":9999999}})), 0.);
    assert_eq!(
        telemetry(
            &json!({"telemetry":{"contextTokens":15600,"contextSource":"transcript-estimate"}})
        ),
        0.
    );
    assert_eq!(telemetry(&json!({"telemetry":{"contextTokens":-1}})), 0.);
    assert_eq!(
        telemetry(&json!({"telemetry":{"contextTokens":2000000}})),
        LIMIT
    );
}

#[test]
fn terminal_usage_matches_classic_optional_counter_evidence() {
    assert!(terminal_usage(&Value::Null).is_none());
    assert_eq!(terminal_usage(&json!({"inputTokens":200.8,"outputTokens":4000,"cacheReadTokens":800,"cacheWriteTokens":0,"cacheRetentionMs":300000})).unwrap(),
        json!({"input":200.,"output":4000.,"cacheRead":800.,"cacheWrite":0.,"cacheRetentionMs":300000.}));
    assert_eq!(terminal_usage(&json!({"inputTokens":-1,"cacheObserved":false,"cacheReadTokens":-1,"cacheRetentionMs":86400001})).unwrap(),json!({"input":0.,"output":0.,"cacheObserved":false}));
}

#[test]
fn compact_counts_match_classic_one_decimal_labels() {
    assert_eq!(format_tokens(f64::NAN), "0");
    assert_eq!(format_tokens(f64::INFINITY), "0");
    assert_eq!(format_tokens(-1200.), "-1.2k");
    for (count, expected) in [
        (0., "0"),
        (100., "100"),
        (1200., "1.2k"),
        (43700., "43.7k"),
        (1_000_000., "1M"),
    ] {
        assert_eq!(format_tokens(count), expected);
    }
}

#[test]
fn existing_client_reads_only_context_telemetry_for_the_bound_thread_and_backend() {
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            lines.push(line);
        }
        assert!(lines[0].starts_with(
            "GET /api/runtime/telemetry?threadId=thoughts-fixture&backend=codex HTTP/1.1"
        ));
        assert!(
            lines
                .iter()
                .any(|line| line.eq_ignore_ascii_case("authorization: Bearer fixture-context\r\n"))
        );
        let body = r#"{"telemetry":{"contextTokens":43700,"totalTokens":9999999,"contextSource":"runtime-context"}}"#;
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    });
    let client =
        crate::client::Client::authenticated(&origin, Some("fixture-context".into())).unwrap();
    assert_eq!(fetch(&client, "thoughts-fixture", "codex").unwrap(), 43700.);
    server.join().unwrap();
}

#[test]
fn context_readout_reaches_live_and_terminal_usage_through_production_stream_frames() {
    let history = serde_json::from_value(
        json!({"sessionKey":"llm-chat:thoughts-context", "transcript":[
            {"id":"u","role":"user","text":"go","timestamp":1000}
        ]}),
    )
    .unwrap();
    let mut transcript = crate::stream::Transcript::new(history);
    let frame = |seq, event, data: Value| json!({"channel":"orchestrator","event":event,"seq":seq,"data":data});
    assert!(transcript.apply(&frame(1,"output",json!({"threadId":"thoughts-context","assistantMessageId":"a","backend":"codex","model":"fixture","text":"answer"}))));
    let (entries, running) = transcript.context_snapshot();
    assert!(running);
    assert_eq!(entries.last().unwrap().text, "answer");
    assert!(conversation(entries) > 1.);
    assert!(latest_reuse(entries).is_none());
    assert!(transcript.apply(&frame(2,"status",json!({"threadId":"thoughts-context","assistantMessageId":"a","backend":"codex","status":"ready","usage":{"inputTokens":200,"outputTokens":4000,"cacheReadTokens":800,"cacheWriteTokens":0,"cacheRetentionMs":300000}}))));
    let (entries, running) = transcript.context_snapshot();
    assert!(!running);
    assert_eq!(latest_reuse(entries).unwrap().percent, 80.);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64;
    let rows = observe(
        "stream-fixture",
        "thoughts-context",
        "codex",
        entries,
        running,
        Some(now),
        now,
    );
    assert_eq!(
        label(
            "codex",
            estimate(&rows, "thoughts-context", "codex", "fixture", now).as_ref(),
            false
        ),
        "Warm ~5m"
    );
    // Another thread and a replayed earlier sequence cannot alter this readout.
    assert!(!transcript.apply(&frame(
        3,
        "status",
        json!({"threadId":"thoughts-other","status":"ready","usage":{"cacheReadTokens":0}})
    )));
    assert!(!transcript.apply(&frame(
        1,
        "output",
        json!({"threadId":"thoughts-context","assistantMessageId":"a","text":"stale"})
    )));
    assert_eq!(
        latest_reuse(transcript.context_snapshot().0)
            .unwrap()
            .percent,
        80.
    );
}
