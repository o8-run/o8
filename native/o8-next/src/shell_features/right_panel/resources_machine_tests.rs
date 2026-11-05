// The Machine section's view model, without a window.
use super::*;
fn machine(value: Value) -> Machine {
    serde_json::from_value(value).unwrap()
}
fn full(at: f64, cpu: f64, net: f64) -> Machine {
    machine(json!({
        "name": "local", "sampledAt": at, "cpuPercent": cpu, "loadAverage": [1.5, 1.25, 0.75], "cores": 8,
        "memory": {"usedBytes": 8589934592u64, "totalBytes": 17179869184u64},
        "swap": {"usedBytes": 0, "totalBytes": 2147483648u64},
        "disks": {
            "data": {"usedBytes": 375809638400u64, "freeBytes": 107374182400u64, "totalBytes": 536870912000u64},
            "projects": null
        },
        "network": {"inBytesPerSec": net, "outBytesPerSec": 2048}
    }))
}
fn close(actual: Option<f32>, expected: f64) {
    let actual = actual.expect("a filled bar");
    assert!(
        (f64::from(actual) - expected).abs() < 1e-6,
        "{actual} != {expected}"
    );
}
fn meter<'a>(view: &'a MachineView, id: &str) -> &'a Meter {
    view.meters.iter().find(|m| m.id == id).unwrap()
}
#[test]
fn formats_six_meters_with_load_and_cores() {
    let mut history = History::default();
    let sample = full(1., 37.4, 1572864.);
    history.push(&sample);
    let view = machine_view(&sample, &history);
    assert_eq!(view.name, "local");
    assert_eq!(view.summary, "8 cores · load 1.50 1.25 0.75");
    assert_eq!(
        view.meters.iter().map(|m| m.label).collect::<Vec<_>>(),
        [
            "CPU",
            "Memory",
            "Swap",
            "Data disk",
            "Projects disk",
            "Network"
        ]
    );
    assert_eq!(meter(&view, "cpu").value, "37%");
    close(meter(&view, "cpu").fraction, 0.374);
    assert_eq!(meter(&view, "memory").value, "8.0 GB / 16 GB");
    assert_eq!(meter(&view, "memory").fraction, Some(0.5));
    assert_eq!(meter(&view, "swap").value, "0 MB / 2.0 GB");
    assert_eq!(meter(&view, "swap").fraction, Some(0.));
    assert_eq!(meter(&view, "disk-data").value, "100 GB free of 500 GB");
    close(meter(&view, "disk-data").fraction, 0.7);
    assert_eq!(meter(&view, "network").value, "↓ 1.5 MB/s · ↑ 2 KB/s");
    assert_eq!(meter(&view, "network").fraction, Some(1.));
}
#[test]
fn missing_fields_render_as_unknown_not_zero() {
    let view = machine_view(
        &machine(
            json!({"cpuPercent": null, "memory": {"totalBytes": null}, "swap": {"totalBytes": 0}}),
        ),
        &History::default(),
    );
    assert_eq!(view.name, "local", "an unnamed machine is this one");
    assert_eq!(view.summary, "");
    for id in ["cpu", "memory", "disk-data", "disk-projects", "network"] {
        assert_eq!(meter(&view, id).value, "—", "{id}");
        assert_eq!(meter(&view, id).fraction, None, "{id}");
    }
    assert_eq!(meter(&view, "swap").value, "None");
    assert!(view.spark.is_empty());
    // An older server without the block still parses.
    let old: Snapshot = serde_json::from_value(json!({
        "sessions": [], "processes": [], "total": {"cpuPercent": 1, "memBytes": 1, "ramTotalBytes": 2}
    }))
    .unwrap();
    assert!(old.machine.is_none());
}
#[test]
fn sparkline_keeps_the_last_sixty_distinct_samples() {
    let mut history = History::default();
    for at in 0..75 {
        let sample = full(at as f64, at as f64, 1000. * at as f64);
        history.push(&sample);
        history.push(&sample);
    }
    assert_eq!(
        history.cpu.len(),
        HISTORY,
        "repeated cached samples add no point"
    );
    assert_eq!(history.cpu.front(), Some(&15.));
    assert_eq!(history.cpu.back(), Some(&74.));
    let view = machine_view(&full(75., 50., 37000.), &history);
    assert_eq!(view.spark.len(), HISTORY);
    close(Some(view.spark[0]), 0.15);
    // Network scales against the recent peak (74000 B/s in plus 2048 out).
    close(meter(&view, "network").fraction, 39048. / 76048.);
    history.push(&machine(json!({"sampledAt": 100., "cpuPercent": null})));
    assert_eq!(
        history.cpu.back(),
        Some(&74.),
        "an unread CPU is a gap, not an idle point"
    );
    history.push(&machine(json!({"cpuPercent": 10})));
    assert_eq!(
        history.cpu.len(),
        HISTORY,
        "a sample without a time is not recorded"
    );
}
#[test]
fn a_saved_machine_says_why_it_has_no_meters() {
    let dead = crate::shell::settings::machine_links::dead_client;
    assert_eq!(
        remote_status(&Reach::Connecting, None).as_deref(),
        Some("Connecting…")
    );
    assert_eq!(
        remote_status(&Reach::Offline("Connection lost.".into()), None).as_deref(),
        Some("Offline · Connection lost.")
    );
    assert_eq!(
        remote_status(&Reach::Offline(" ".into()), None).as_deref(),
        Some("Offline")
    );
    assert_eq!(
        remote_status(&Reach::Online(dead()), None).as_deref(),
        Some("Reading…"),
        "online, before the first reading"
    );
    let failed = Remote {
        error: Some("HTTP 404".into()),
        ..Remote::default()
    };
    assert_eq!(
        remote_status(&Reach::Online(dead()), Some(&failed)).as_deref(),
        Some("HTTP 404")
    );
    let read = Remote {
        machine: Some(full(1., 20., 0.)),
        error: Some("a later read failed".into()),
        ..Remote::default()
    };
    assert_eq!(
        remote_status(&Reach::Online(dead()), Some(&read)),
        None,
        "a known reading keeps its meters"
    );
}
#[test]
fn a_saved_machine_keeps_one_read_in_flight_and_ignores_old_replies() {
    let mut remote = Remote::default();
    assert!(remote.start(1));
    assert!(!remote.start(2), "one read at a time");
    assert!(
        !remote.finish(2, Ok(Some(full(1., 10., 0.)))),
        "not its request"
    );
    assert!(remote.machine.is_none());
    assert!(remote.finish(1, Ok(Some(full(1., 10., 0.)))));
    assert!(remote.start(3), "the next read starts once the reply lands");
}
#[test]
fn a_failed_read_marks_the_reading_stale_then_drops_it() {
    let mut remote = Remote::default();
    remote.start(1);
    remote.finish(1, Ok(Some(full(1., 10., 0.))));
    assert_eq!(remote.stale(), None);
    remote.start(2);
    remote.finish(2, Err("HTTP 502".into()));
    assert_eq!(remote.stale().as_deref(), Some("Stale · HTTP 502"));
    assert!(
        remote.machine.is_some(),
        "one failure keeps the last reading"
    );
    for request in 3..=STALE_LIMIT as u64 + 1 {
        remote.start(request);
        remote.finish(request, Err("HTTP 502".into()));
    }
    assert!(remote.machine.is_none(), "{STALE_LIMIT} failures drop it");
    assert!(remote.history.cpu.is_empty());
    assert_eq!(remote.stale(), None);
    assert_eq!(
        remote_status(
            &Reach::Online(crate::shell::settings::machine_links::dead_client()),
            Some(&remote)
        )
        .as_deref(),
        Some("HTTP 502"),
        "the last error stays visible"
    );
    remote.start(9);
    remote.finish(9, Ok(Some(full(9., 30., 0.))));
    assert_eq!((remote.failures, remote.stale()), (0, None));
}
#[test]
fn only_online_machines_keep_a_reading() {
    let dead = crate::shell::settings::machine_links::dead_client;
    let link = |id: &str, reach| MachineLink {
        id: id.into(),
        label: id.into(),
        reach,
    };
    let mut remote: HashMap<String, Remote> = ["up", "down", "dialing", "gone"]
        .into_iter()
        .map(|id| (id.to_owned(), Remote::default()))
        .collect();
    prune(
        &mut remote,
        &[
            link("up", Reach::Online(dead())),
            link("down", Reach::Offline("Connection lost.".into())),
            link("dialing", Reach::Connecting),
        ],
    );
    assert_eq!(remote.keys().collect::<Vec<_>>(), ["up"]);
}
