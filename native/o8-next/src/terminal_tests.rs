use super::*;
use alacritty_terminal::grid::Dimensions;
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    thread,
};

struct Fixture(Child, Option<std::path::PathBuf>);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.0.id().to_string()])
            .status();
        let _ = self.0.wait();
        if let Some(gate) = &self.1 {
            let _ = std::fs::remove_dir_all(gate.parent().unwrap());
        }
    }
}
fn fixture() -> (Fixture, Client, String) {
    fixture_with_tail_gate(None)
}
fn fixture_with_tail_gate(gate: Option<std::path::PathBuf>) -> (Fixture, Client, String) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command
        .current_dir(root)
        .args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "scripts/next/dev-server.ts",
            "--terminal",
        ])
        .env("O8_NEXT_API_TOKEN", "fixture-next-terminal-operator")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(gate) = &gate {
        command.env("O8_NEXT_TERMINAL_FLOOD_TAIL_GATE", gate);
    }
    let mut child = command.spawn().expect("disposable terminal host");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let metadata = lines
        .find_map(|line| {
            let value: Value = serde_json::from_str(&line.ok()?).ok()?;
            value["terminalSession"].is_string().then_some(value)
        })
        .expect("fixture metadata");
    let client = Client::authenticated(
        metadata["origin"].as_str().unwrap(),
        Some("fixture-next-terminal-operator".into()),
    )
    .unwrap();
    (
        Fixture(child, gate),
        client,
        metadata["terminalSession"].as_str().unwrap().into(),
    )
}
fn draw(pane: &Entity<Pane>, cx: &mut VisualTestContext) -> f64 {
    let start = Instant::now();
    pane.update(cx, |pane, cx| pane.poll(cx));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    start.elapsed().as_secs_f64() * 1000.
}
fn until(pane: &Entity<Pane>, cx: &mut VisualTestContext, condition: impl Fn(&Pane) -> bool) {
    let started = Instant::now();
    let bound = Duration::from_secs(45);
    loop {
        draw(pane, cx);
        let elapsed = started.elapsed();
        if elapsed <= bound && pane.read_with(cx, |pane, _| condition(pane)) {
            break;
        }
        assert!(
            elapsed < bound,
            "terminal condition timed out; elapsed={elapsed:?}; bound={bound:?}; notice={}",
            pane.read_with(cx, |pane, _| pane.notice)
        );
        thread::sleep(Duration::from_millis(1));
    }
}
fn command(text: &str, cx: &mut VisualTestContext) {
    cx.simulate_input(text);
    cx.simulate_keystrokes("enter");
}
fn percentile(values: &[f64], quantile: f64) -> f64 {
    let mut values = values.to_vec();
    values.sort_by(f64::total_cmp);
    values[((values.len() as f64 * quantile).ceil() as usize).saturating_sub(1)]
}
fn rss() -> f64 {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string("/proc/self/status").expect("Linux RSS");
        stat.lines()
            .find_map(|line| {
                line.strip_prefix("VmRSS:")?
                    .split_whitespace()
                    .next()?
                    .parse::<f64>()
                    .ok()
            })
            .unwrap()
            / 1024.
    }
    #[cfg(not(target_os = "linux"))]
    {
        let output = Command::new("ps")
            .args(["-p", &std::process::id().to_string(), "-o", "rss="])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<f64>()
            .unwrap()
            / 1024.
    }
}

// The marker can arrive before its trailing newline in another transport chunk.
fn line_received(grid: &Grid, marker: &str) -> bool {
    grid.text().contains(marker)
        && grid.cursor().is_some_and(|(column, row, _)| {
            column == 0
                && grid
                    .cells()
                    .iter()
                    .filter(|cell| cell.y == row)
                    .all(|cell| cell.text.trim().is_empty())
        })
}

fn wait_for_flood(
    pane: &Entity<Pane>,
    cx: &mut VisualTestContext,
    before: u64,
) -> (Vec<f64>, Duration) {
    let mut frames = vec![];
    let started = Instant::now();
    let bound = Duration::from_secs(90);
    loop {
        let previous = pane.read_with(cx, |pane, _| pane.painted.get());
        let frame_ms = draw(pane, cx);
        let (received, painted, complete, notice) = pane.read_with(cx, |pane, _| {
            let grid = pane.grid.lock().unwrap();
            let received = grid.bytes - before;
            (
                received,
                pane.painted_bytes.get().saturating_sub(before),
                received >= 50_000_012
                    && line_received(&grid, "FLOOD-DONE")
                    && pane.painted_bytes.get() >= grid.bytes,
                pane.notice,
            )
        });
        if pane.read_with(cx, |pane, _| pane.painted.get() != previous) {
            frames.push(frame_ms);
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed <= bound,
            "50 MB flood timed out; elapsed={elapsed:?}; bound={bound:?}; received={received}; painted={painted}; notice={notice}"
        );
        if complete {
            return (frames, elapsed);
        }
        thread::sleep(Duration::from_millis(1));
    }
}

#[gpui::test]
fn production_pty_to_gpui_terminal(cx: &mut TestAppContext) {
    let (_server, client, session) = fixture();
    let (pane, cx) = cx.add_window_view(|window, cx| Pane::new(client, session, window, cx));
    until(&pane, cx, |pane| {
        pane.ready && line_received(&pane.grid.lock().unwrap(), "READY")
    });
    // Input originates in GPUI's native platform handler, not a helper encoder.
    command("key", cx);
    until(&pane, cx, |pane| {
        line_received(&pane.grid.lock().unwrap(), "KEY")
    });
    let key_revision = pane.read_with(cx, |pane, _| pane.grid.lock().unwrap().revision);
    until(&pane, cx, |pane| pane.painted.get() >= key_revision);
    pane.read_with(cx, |pane, _| {
        let grid = pane.grid.lock().unwrap();
        let cells = grid.cells();
        assert!(
            cells
                .iter()
                .any(|c| c.text == "K" && c.foreground == 0xcd3131)
        );
        assert!(cells.iter().any(|c| c.text == "界" && c.width == 2));
        assert!(cells.iter().any(|c| c.text == "e\u{301}"));
        assert!(
            pane.painted.get() >= key_revision,
            "parsed key revision must reach GPUI paint"
        );
        assert!(pane.painted_cursor.get());
        assert!(pane.painted_cells.get() > 0);
    });
    command("alt", cx);
    until(&pane, cx, |pane| {
        pane.grid.lock().unwrap().text().contains("ALTERNATE")
    });
    assert!(pane.read_with(cx, |pane, _| {
        pane.grid
            .lock()
            .unwrap()
            .term
            .mode()
            .contains(TermMode::ALT_SCREEN)
    }));
    command("primary", cx);
    until(&pane, cx, |pane| {
        !pane
            .grid
            .lock()
            .unwrap()
            .term
            .mode()
            .contains(TermMode::ALT_SCREEN)
    });
    assert!(pane.read_with(cx, |pane, _| {
        pane.grid.lock().unwrap().text().contains("KEY")
    }));
    // Resize the actual GPUI viewport. Its canvas computes the grid and sends
    // terminal-resize; the fixture reads the resulting kernel winsize.
    for (width, height, expected) in [(768., 584., Size(92, 29)), (793., 607., Size(95, 30))] {
        cx.simulate_resize(size(px(width), px(height)));
        draw(&pane, cx);
        draw(&pane, cx);
        let (bounds, dimensions) = pane.read_with(cx, |pane, _| {
            (pane.painted_bounds.get(), pane.grid.lock().unwrap().size())
        });
        // Desktop CSS: 12px panel padding on every side, plus xterm's 2px
        // top/left content padding. The native status strip occupies 26px.
        assert_eq!(
            bounds.origin,
            point(px(14.), px(40.)),
            "terminal content must be inset"
        );
        assert_eq!(bounds.size, size(px(width - 26.), px(height - 52.)));
        assert_eq!(dimensions, expected);
        assert_eq!(
            dimensions,
            Size(
                (f32::from(bounds.size.width) / 8.).floor() as usize,
                (f32::from(bounds.size.height) / 18.).floor() as usize,
            ),
            "PTY columns/rows must use the visible canvas and unchanged 8x18px cells"
        );
        thread::sleep(Duration::from_millis(10));
        command("size", cx);
        until(&pane, cx, |pane| {
            pane.grid
                .lock()
                .unwrap()
                .text()
                .contains(&format!("SIZE {} {}", dimensions.0, dimensions.1))
        });
        println!("terminal viewport={width}x{height} content={bounds:?} kernel-pty={dimensions:?}");
    }
    // Quantify two distinct endpoints: local input dispatch -> CPU scene, and
    // input -> actual server/PTY echo -> first CPU scene containing that echo.
    let mut echo = vec![];
    let mut local = vec![];
    for _ in 0..30 {
        cx.simulate_input("key");
        let before = pane.read_with(cx, |pane, _| pane.grid.lock().unwrap().bytes);
        let start = Instant::now();
        cx.simulate_keystrokes("enter");
        draw(&pane, cx);
        local.push(start.elapsed().as_secs_f64() * 1000.);
        until(&pane, cx, |pane| pane.painted_bytes.get() > before);
        echo.push(start.elapsed().as_secs_f64() * 1000.);
    }
    command("scroll", cx);
    until(&pane, cx, |pane| {
        line_received(&pane.grid.lock().unwrap(), "SCROLL-DONE")
    });
    assert_eq!(
        pane.read_with(cx, |pane, _| pane
            .grid
            .lock()
            .unwrap()
            .term
            .grid()
            .history_size()),
        10_000
    );
    let full_memory = rss();
    cx.simulate_keystrokes("shift-home");
    draw(&pane, cx);
    let top = pane.read_with(cx, |pane, _| {
        pane.grid.lock().unwrap().term.grid().display_offset()
    });
    assert_eq!(top, 10_000);
    cx.simulate_keystrokes("shift-end");
    draw(&pane, cx);
    assert_eq!(
        pane.read_with(cx, |pane, _| pane
            .grid
            .lock()
            .unwrap()
            .term
            .grid()
            .display_offset()),
        0
    );
    // Full 50 MB at an explicit 2.5 MB/s, following the repository's fixed-rate
    // terminal workload pattern. Unpaced saturation remains a separate probe.
    let before = pane.read_with(cx, |pane, _| pane.grid.lock().unwrap().bytes);
    command("flood", cx);
    let (frames, flood_elapsed) = wait_for_flood(&pane, cx, before);
    let received = pane.read_with(cx, |pane, _| pane.grid.lock().unwrap().bytes - before);
    assert_eq!(
        received, 50_000_012,
        "no silent terminal transport loss during flood; elapsed={flood_elapsed:?}"
    );
    assert!(frames.len() > 20);
    assert_eq!(
        pane.read_with(cx, |pane, _| pane
            .grid
            .lock()
            .unwrap()
            .term
            .grid()
            .history_size()),
        10_000
    );
    let result = json!({"endpoint":"GPUI TestAppContext CPU scene paint; no GPU presentation","platform":std::env::consts::OS,
        "profile":if cfg!(debug_assertions) { "debug" } else { "release" },
        "keyToEchoFrameP50Ms":percentile(&echo,0.50),"keyToEchoFrameP95Ms":percentile(&echo,0.95),
        "localKeyToFrameP50Ms":percentile(&local,0.50),"localKeyToFrameP95Ms":percentile(&local,0.95),
        "floodFrameP95Ms":percentile(&frames,0.95),"floodBytes":received,"floodFrames":frames.len(),"producerBytesPerSecond":2_500_000,
        "fullScrollbackLines":10_000,"fullScrollbackRssMiB":full_memory,
        "keySamples":30,"floodFrameMs":frames,"keyToEchoFrameMs":echo,"localKeyToFrameMs":local});
    if let Ok(path) = std::env::var("O8_NEXT_TERMINAL_RESULTS") {
        std::fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    }
    println!("O8_NEXT_TERMINAL_EVIDENCE {result}");
}

#[gpui::test]
fn production_pty_flood_waits_for_delayed_tail(cx: &mut TestAppContext) {
    let directory = std::env::temp_dir().join(format!(
        "o8-terminal-tail-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let gate = directory.join("release");
    let (_server, client, session) = fixture_with_tail_gate(Some(gate.clone()));
    let (pane, cx) = cx.add_window_view(|window, cx| Pane::new(client, session, window, cx));
    until(&pane, cx, |pane| {
        pane.ready && line_received(&pane.grid.lock().unwrap(), "READY")
    });
    let before = pane.read_with(cx, |pane, _| pane.grid.lock().unwrap().bytes);
    command("flood", cx);
    until(&pane, cx, |pane| {
        pane.grid.lock().unwrap().text().contains("FLOOD-DONE")
    });
    thread::scope(|scope| {
        scope.spawn(move || {
            // Delay the final output event after the marker has already arrived.
            thread::sleep(Duration::from_secs(2));
            std::fs::write(gate, b"release").unwrap();
        });
        let (_, elapsed) = wait_for_flood(&pane, cx, before);
        let received = pane.read_with(cx, |pane, _| pane.grid.lock().unwrap().bytes - before);
        assert_eq!(
            received, 50_000_012,
            "complete flood tail must be received and painted; elapsed={elapsed:?}"
        );
    });
}

#[test]
fn replay_queries_split_utf8_and_reset() {
    let mut grid = Grid::new(Size(20, 5));
    assert!(
        grid.feed(b"\x1b[6n", true).is_empty(),
        "historical queries must never write to the PTY"
    );
    assert!(
        !grid.feed(b"\x1b[6n", false).is_empty(),
        "live DSR must be answered"
    );
    assert_eq!(grid.feed(b"\x1b[14t", false), vec!["\x1b[4;90;160t"]);
    assert!(grid.feed(b"\x1b[14t\x1b]10;?\x07", true).is_empty());
    let text = "\x1b[38;2;12;34;56m界e\u{301}".as_bytes();
    for byte in text {
        grid.feed(&[*byte], false);
    }
    assert!(
        grid.cells()
            .iter()
            .any(|c| c.text == "界" && c.width == 2 && c.foreground == 0x0c2238)
    );
    assert!(grid.cells().iter().any(|c| c.text == "e\u{301}"));
    grid.feed(b"\x1b[?25l", false);
    assert!(grid.cursor().is_none());
    grid.reset();
    grid.feed(b"replacement", true);
    assert!(!grid.text().contains('界'));
    assert!(grid.text().contains("replacement"));
}

#[test]
fn terminal_keys_follow_application_cursor_and_modifiers() {
    for (key, expected) in [
        ("ctrl-c", "\x03"),
        ("enter", "\r"),
        ("shift-tab", "\x1b[Z"),
        ("ctrl-up", "\x1b[1;5A"),
        ("f12", "\x1b[24~"),
    ] {
        assert_eq!(
            encode_key(&Keystroke::parse(key).unwrap(), TermMode::empty()).as_deref(),
            Some(expected)
        );
    }
    assert_eq!(
        encode_key(&Keystroke::parse("up").unwrap(), TermMode::APP_CURSOR).as_deref(),
        Some("\x1bOA")
    );
}
