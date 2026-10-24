//! Keyboard and paint checks use the production root, HTTP inventory and real PTYs.
use super::*;
use gpui::Entity;

fn tick(grid: &Entity<Grid>, cx: &mut VisualTestContext) {
    grid.update(cx, |grid, cx| grid.poll(cx));
    draw(cx);
}
fn until(grid: &Entity<Grid>, cx: &mut VisualTestContext, condition: impl Fn(&Grid, &App) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        tick(grid, cx);
        if grid.read_with(cx, |grid, cx| condition(grid, cx)) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "grid terminal condition timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn terminal(
    grid: &Entity<Grid>,
    index: usize,
    cx: &mut VisualTestContext,
) -> Entity<crate::terminal::Pane> {
    grid.read_with(cx, |grid, _| {
        grid.panes[index].terminal.clone().expect("attached slot")
    })
}
fn bytes(grid: &Entity<Grid>, cx: &mut VisualTestContext) -> Vec<u64> {
    grid.read_with(cx, |grid, cx| {
        (0..3)
            .map(|index| {
                grid.panes[index]
                    .terminal
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .grid
                    .lock()
                    .unwrap()
                    .bytes
            })
            .collect()
    })
}
fn three_terminals(grid: &Entity<Grid>, cx: &mut VisualTestContext) {
    for _ in 0..3 {
        cx.simulate_keystrokes("ctrl-alt-t");
        draw(cx);
        cx.simulate_keystrokes("ctrl-alt-right");
    }
    // Right stays on column 2. Return to the first terminal without PTY input.
    cx.simulate_keystrokes("ctrl-alt-left ctrl-alt-left");
    until(grid, cx, |grid, cx| {
        grid.panes[..3].iter().all(|pane| {
            pane.terminal.as_ref().is_some_and(|terminal| {
                terminal.read(cx).ready && terminal.read(cx).painted_bytes.get() > 0
            })
        })
    });
}
fn input(command: &str, cx: &mut VisualTestContext) {
    cx.simulate_input(command);
    cx.simulate_keystrokes("enter");
}

struct TerminalClip(Entity<crate::terminal::Pane>);
impl Render for TerminalClip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().w(px(300.)).h(px(10.)).overflow_hidden().child(
            div()
                .mt(px(100.))
                .h(px(100.))
                .flex()
                .flex_col()
                .child(crate::pane::clipped(self.0.clone().into_any_element())),
        )
    }
}

#[gpui::test]
fn real_slot_terminals_route_keys_retain_hidden_attachments_and_restart(cx: &mut TestAppContext) {
    let fixture = Fixture::with_terminals(true);
    let (grid, cx) = cx.add_window_view(|window, cx| {
        Grid::new(fixture.client.clone(), fixture.options.clone(), window, cx)
    });
    grid.update(cx, |grid, cx| grid.load(cx));
    cx.run_until_parked();
    draw(cx);
    three_terminals(&grid, cx);
    let first = terminal(&grid, 0, cx);
    let second = terminal(&grid, 1, cx);
    let initial = bytes(&grid, cx);
    cx.simulate_keystrokes("ctrl-alt-right");
    cx.simulate_input("key");
    cx.simulate_keystrokes("tab enter");
    assert_eq!(
        grid.read_with(cx, |grid, _| grid.layout.focus),
        1,
        "Tab must reach the PTY"
    );
    until(&grid, cx, |_, cx| {
        second.read(cx).grid.lock().unwrap().bytes > initial[1]
    });
    second.read_with(cx, |pane, _| {
        let cells = pane
            .grid
            .lock()
            .unwrap()
            .cells()
            .iter()
            .map(|cell| cell.text.clone())
            .collect::<String>();
        assert!(
            cells.contains("KEY"),
            "the focused PTY must echo the actual input"
        );
    });
    let after = bytes(&grid, cx);
    assert_eq!(after[0], initial[0]);
    assert_eq!(after[2], initial[2]);
    // Reordering moves the session, terminal entity and persisted view together.
    cx.simulate_keystrokes("ctrl-alt-shift-left");
    assert_eq!(terminal(&grid, 0, cx), second);
    assert_eq!(terminal(&grid, 1, cx), first);
    let expected = grid.read_with(cx, |grid, _| grid.layout.clone());
    assert_eq!(fixture.options.load().unwrap().unwrap(), expected);
    // A slot without an inventory binding remains usable and never guesses an id.
    cx.simulate_keystrokes("ctrl-alt-down ctrl-alt-t");
    draw(cx);
    assert!(grid.read_with(cx, |grid, _| grid.panes[3].terminal.is_none()));
    cx.simulate_keystrokes("ctrl-alt-t ctrl-alt-up");
    let live = terminal(&grid, 0, cx);
    input("flood", cx);
    let before = live.read_with(cx, |pane, _| pane.grid.lock().unwrap().bytes);
    until(&grid, cx, |_, cx| {
        live.read(cx).grid.lock().unwrap().bytes > before + 10000
    });
    cx.simulate_keystrokes("ctrl-alt-t");
    draw(cx);
    let paints = live.read_with(cx, |pane, _| pane.paints.get());
    let before = live.read_with(cx, |pane, _| pane.grid.lock().unwrap().bytes);
    until(&grid, cx, |_, cx| {
        live.read(cx).grid.lock().unwrap().bytes > before + 100000
    });
    assert_eq!(
        live.read_with(cx, |pane, _| pane.paints.get()),
        paints,
        "transcript-selected terminal must stop painting"
    );
    assert_eq!(
        terminal(&grid, 0, cx),
        live,
        "switching views must retain the attachment"
    );
    cx.simulate_keystrokes("ctrl-alt-t ctrl-alt-right ctrl-alt-1");
    draw(cx);
    // Slot 0 is visible; put the flooding terminal off screen via zoom of slot 1.
    cx.simulate_keystrokes("ctrl-alt-6 ctrl-alt-right ctrl-alt-enter");
    draw(cx);
    let paints = live.read_with(cx, |pane, _| pane.paints.get());
    let before = live.read_with(cx, |pane, _| pane.grid.lock().unwrap().bytes);
    until(&grid, cx, |_, cx| {
        live.read(cx).grid.lock().unwrap().bytes > before + 100000
    });
    assert_eq!(
        live.read_with(cx, |pane, _| pane.paints.get()),
        paints,
        "zoom-hidden terminal must stop painting"
    );
    cx.simulate_keystrokes("ctrl-alt-enter ctrl-alt-left");
    draw(cx);
    assert!(live.read_with(cx, |pane, _| pane.paints.get()) > paints);
    // Entirely clipped content must neither paint glyphs nor resize its PTY.
    let paints = live.read_with(cx, |pane, _| pane.paints.get());
    let dimensions = live.read_with(cx, |pane, _| pane.grid.lock().unwrap().size());
    cx.update(|window, cx| {
        window.replace_root(cx, |_, _| TerminalClip(live.clone()));
    });
    for _ in 0..3 {
        tick(&grid, cx);
    }
    assert_eq!(live.read_with(cx, |pane, _| pane.paints.get()), paints);
    assert_eq!(
        live.read_with(cx, |pane, _| pane.grid.lock().unwrap().size()),
        dimensions
    );
    let expected = grid.read_with(cx, |grid, _| grid.layout.clone());
    cx.update(|window, cx| {
        let restored = window.replace_root(cx, |window, cx| {
            Grid::new(fixture.client.clone(), fixture.options.clone(), window, cx)
        });
        assert_eq!(restored.read(cx).layout, expected);
    });
    // Old files from the transcript grid remain valid; other workspaces stay separate.
    let mut old = serde_json::to_value(&expected).unwrap();
    old.as_object_mut().unwrap().remove("views");
    fs::write(
        &fixture.options.file,
        json!({&fixture.options.workspace: old}).to_string(),
    )
    .unwrap();
    assert_eq!(
        fixture.options.load().unwrap().unwrap().views,
        vec![View::Transcript; 6]
    );
}

#[gpui::test]
#[ignore = "explicit six-slot / three-flooding-terminal CPU scene measurement"]
fn grid_terminal_measurement(cx: &mut TestAppContext) {
    let fixture = Fixture::with_terminals(true);
    let (grid, cx) = cx.add_window_view(|window, cx| {
        Grid::new(fixture.client.clone(), fixture.options.clone(), window, cx)
    });
    grid.update(cx, |grid, cx| grid.load(cx));
    cx.run_until_parked();
    draw(cx);
    three_terminals(&grid, cx);
    let output = Command::new("ps")
        .args(["-p", &std::process::id().to_string(), "-o", "rss="])
        .output()
        .unwrap();
    let rss = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .unwrap()
        / 1024.;
    let focused = terminal(&grid, 0, cx);
    let mut keys = vec![];
    for _ in 0..30 {
        let before = focused.read_with(cx, |pane, _| pane.grid.lock().unwrap().bytes);
        let started = Instant::now();
        input("key", cx);
        until(&grid, cx, |_, cx| {
            let pane = focused.read(cx);
            let bytes = pane.grid.lock().unwrap().bytes;
            bytes > before && pane.painted_bytes.get() >= bytes
        });
        keys.push(started.elapsed().as_secs_f64() * 1000.);
    }
    for _ in 0..3 {
        input("flood", cx);
        cx.simulate_keystrokes("ctrl-alt-right");
    }
    cx.simulate_keystrokes("ctrl-alt-left ctrl-alt-left");
    let mut sequences = bytes(&grid, cx);
    let initial = sequences.clone();
    let mut frames = vec![];
    let deadline = Instant::now() + Duration::from_secs(15);
    while frames.len() < 60 {
        assert!(Instant::now() < deadline, "three-terminal flood deadline");
        let next = bytes(&grid, cx);
        if next.iter().zip(&sequences).all(|(a, b)| a > b) {
            let started = Instant::now();
            tick(&grid, cx);
            frames.push(started.elapsed().as_secs_f64() * 1000.);
            grid.read_with(cx, |grid, cx| {
                for (index, bytes) in next.iter().enumerate() {
                    assert!(
                        grid.panes[index]
                            .terminal
                            .as_ref()
                            .unwrap()
                            .read(cx)
                            .painted_bytes
                            .get()
                            >= *bytes,
                        "each timed scene must paint all three flooding terminals"
                    );
                }
            });
            sequences = next;
        } else {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    println!(
        "O8_GRID_TERMINAL_EVIDENCE {}",
        json!({
            "endpoint":"Linux GPUI TestAppContext CPU scene; no-op text system; no GPU/compositor",
            "slots":6,"terminalSlots":3,"transcriptSlots":3,"transcriptRowsPerSlot":100,
            "producerBytesPerSecondPerTerminal":2500000,"frameSamples":frames,"keyEchoToFrameSamples":keys,
            "idleMemoryMiB":rss,"initialTerminalBytes":initial,"finalTerminalBytes":sequences,
            "viewport":cx.update(|window,_| { let s=window.viewport_size(); json!({"width":f32::from(s.width),"height":f32::from(s.height)}) })
        })
    );
}
