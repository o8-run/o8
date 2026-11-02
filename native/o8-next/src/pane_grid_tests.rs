use super::*;
use gpui::{TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Instant,
};

struct Fixture {
    server: Child,
    client: Client,
    options: Options,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        Self::with_terminals(false)
    }
    fn with_terminals(terminals: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-pane-grid-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let mut server = Command::new("node")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "scripts/next/grid-dev-server.ts",
                "--owned-stdio",
            ])
            .args(if terminals {
                vec!["--terminals"]
            } else {
                vec![]
            })
            .env("O8_NEXT_API_TOKEN", "fixture-grid-bearer")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(server.stdout.take().unwrap()).lines();
        let origin = output
            .find_map(|line| {
                serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                    .as_str()
                    .map(str::to_owned)
            })
            .expect("fixture origin");
        std::thread::spawn(move || for _ in output {});
        let client = Client::authenticated(&origin, Some("fixture-grid-bearer".into())).unwrap();
        let workspace = client
            .sessions()
            .unwrap()
            .iter()
            .find(|s| s.id.starts_with("thoughts-grid-"))
            .expect("production route must supply fixture workers")
            .repo_path
            .clone()
            .unwrap();
        let options = Options {
            size: 6,
            workspace,
            file: root.join("layouts.json"),
        };
        if terminals {
            options
                .save(&Layout::new(
                    6,
                    (0..6).map(|index| {
                        if index < 3 {
                            format!("pi-owned:grid-terminal-{index}")
                        } else {
                            format!("llm-chat:thoughts-grid-{index}")
                        }
                    }),
                ))
                .unwrap();
        }
        Self {
            server,
            client,
            options,
            root,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.server.id().to_string()])
            .status();
        let _ = self.server.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

struct ClipProbe(gpui::Entity<Grid>);
impl Render for ClipProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().w(px(300.)).h(px(10.)).overflow_hidden().child(
            div()
                .mt(px(100.))
                .h(px(100.))
                .flex()
                .flex_col()
                .child(self.0.read(cx).panes[0].content()),
        )
    }
}

#[gpui::test]
fn real_workspace_grid_focus_reorder_close_and_restart(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (grid, cx) = cx.add_window_view(|window, cx| {
        Grid::new(fixture.client.clone(), fixture.options.clone(), window, cx)
    });
    grid.update(cx, |g, cx| g.load(cx));
    cx.run_until_parked();
    draw(cx);
    grid.read_with(cx, |g, _| {
        assert_eq!(g.layout.size, 6);
        assert_eq!(g.panes.iter().filter(|p| p.transcript.is_some()).count(), 6);
        assert!(
            g.panes
                .iter()
                .all(|p| p.title.chars().count() <= 40 && !p.state.contains("Running"))
        );
    });
    let original = grid.read_with(cx, |g, _| g.layout.sessions.clone());
    cx.simulate_keystrokes("ctrl-alt-right");
    assert_eq!(grid.read_with(cx, |g, _| g.layout.focus), 1);
    cx.simulate_keystrokes("ctrl-alt-down");
    assert_eq!(grid.read_with(cx, |g, _| g.layout.focus), 4);
    cx.simulate_keystrokes("ctrl-alt-shift-left");
    assert_eq!(grid.read_with(cx, |g, _| g.layout.focus), 3);
    assert_eq!(
        grid.read_with(cx, |g, _| g.layout.sessions[3].clone()),
        original[4]
    );
    cx.simulate_keystrokes("ctrl-alt-w");
    assert!(grid.read_with(cx, |g, _| g.layout.sessions[3].is_none()
        && g.panes[3].transcript.is_none()));
    cx.simulate_keystrokes("ctrl-alt-p");
    cx.run_until_parked();
    assert!(grid.read_with(cx, |g, _| g.panes[3].transcript.is_some()));
    for size in [1, 2, 4, 6] {
        cx.simulate_keystrokes(&format!("ctrl-alt-{size}"));
        draw(cx);
        assert_eq!(grid.read_with(cx, |g, _| g.layout.size), size);
    }
    for (width, height) in [(900., 700.), (1680., 1050.)] {
        let handle = cx.update(|window, _| window.window_handle());
        cx.cx
            .simulate_window_resize(handle, size(px(width), px(height)));
        draw(cx);
        for selector in ["pane-0", "pane-1", "pane-2", "pane-3", "pane-4", "pane-5"] {
            let bounds = cx
                .debug_bounds(selector)
                .expect("pane is reachable at both window sizes");
            assert!(bounds.size.width > px(0.) && bounds.size.height > px(0.));
            assert!(bounds.right() <= px(width) && bounds.bottom() <= px(height));
        }
    }
    let expected = grid.read_with(cx, |g, _| g.layout.clone());
    assert_eq!(fixture.options.load().unwrap(), Some(expected.clone()));
    let mut other = fixture.options.clone();
    other.workspace = "/fixture/another-workspace".into();
    assert_eq!(other.load().unwrap(), None);
    other.save(&Layout::new(2, std::iter::empty())).unwrap();
    assert_eq!(fixture.options.load().unwrap(), Some(expected.clone()));
    // Construct a fresh root using the same public startup path and disk state.
    cx.update(|window, cx| {
        let restored =
            cx.new(|cx| Grid::new(fixture.client.clone(), fixture.options.clone(), window, cx));
        assert_eq!(restored.read(cx).layout, expected);
    });
    let runtime_layout = Layout::new(1, std::iter::once("pi-owned:grid-runtime".into()));
    fixture.options.save(&runtime_layout).unwrap();
    let runtime_grid = cx.update(|window, cx| {
        window.replace_root(cx, |window, cx| {
            Grid::new(fixture.client.clone(), fixture.options.clone(), window, cx)
        })
    });
    runtime_grid.update(cx, |g, cx| g.load(cx));
    cx.run_until_parked();
    draw(cx);
    runtime_grid.read_with(cx, |g, _| {
        let pane = &g.panes[0];
        assert_eq!(pane.key.as_deref(), Some("pi-owned:grid-runtime"));
        assert_eq!(pane.state, "working");
        assert!(
            pane.transcript
                .as_ref()
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.text == "Persisted grid runtime answer")
        );
    });
}

#[gpui::test]
fn six_live_panes_cull_hidden_and_clipped_content(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (grid, cx) = cx.add_window_view(|window, cx| {
        Grid::new(fixture.client.clone(), fixture.options.clone(), window, cx)
    });
    grid.update(cx, |g, cx| g.load(cx));
    cx.run_until_parked();
    grid.update(cx, |g, _| {
        for pane in &mut g.panes {
            pane.navigate(true);
        }
    });
    draw(cx);
    // Wait on real sockets with a bounded deadline, no fake stream application.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        grid.update(cx, |g, cx| g.poll(cx));
        draw(cx);
        if grid.read_with(cx, |g, _| {
            g.panes
                .iter()
                .all(|p| p.transcript.as_ref().is_some_and(|t| t.seq > 0))
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "all six independent worker streams must advance"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    cx.simulate_keystrokes("ctrl-alt-1");
    draw(cx);
    let hidden = grid.read_with(cx, |g, _| {
        g.panes[1..]
            .iter()
            .map(|p| {
                (
                    p.paints.get(),
                    p.rows.iter().map(|r| r.borrow().layouts).sum::<usize>(),
                )
            })
            .collect::<Vec<_>>()
    });
    for _ in 0..5 {
        grid.update(cx, |g, cx| g.poll(cx));
        draw(cx);
    }
    grid.read_with(cx, |g, _| {
        for (p, (paints, layouts)) in g.panes[1..].iter().zip(&hidden) {
            assert_eq!(p.paints.get(), *paints, "hidden pane paint must stop");
            assert_eq!(
                p.rows.iter().map(|r| r.borrow().layouts).sum::<usize>(),
                *layouts,
                "hidden pane shaping must stop"
            );
        }
    });
    cx.simulate_keystrokes("ctrl-alt-6");
    draw(cx);
    grid.read_with(cx, |g, _| assert!(g.panes[1].paints.get() > hidden[0].0));
    // Clip the entire transcript gate after changing width, so a missing gate
    // would reshape and paint despite being outside its parent's content mask.
    let before = grid.read_with(cx, |g, _| {
        (
            g.panes[0].paints.get(),
            g.panes[0]
                .rows
                .iter()
                .map(|r| r.borrow().layouts)
                .sum::<usize>(),
        )
    });
    cx.update(|window, cx| {
        window.replace_root(cx, |_, _| ClipProbe(grid.clone()));
    });
    draw(cx);
    grid.read_with(cx, |g, _| {
        assert_eq!(g.panes[0].paints.get(), before.0);
        assert_eq!(
            g.panes[0]
                .rows
                .iter()
                .map(|r| r.borrow().layouts)
                .sum::<usize>(),
            before.1
        );
    });
}

#[gpui::test]
#[ignore = "explicit streaming CPU scene measurement workload"]
fn pane_grid_measurement(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (grid, cx) = cx.add_window_view(|window, cx| {
        Grid::new(fixture.client.clone(), fixture.options.clone(), window, cx)
    });
    grid.update(cx, |g, cx| g.load(cx));
    cx.run_until_parked();
    grid.update(cx, |g, _| {
        for pane in &mut g.panes {
            pane.navigate(true);
        }
    });
    draw(cx);
    let idle_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        grid.update(cx, |g, cx| g.poll(cx));
        if grid.read_with(cx, |g, _| {
            g.panes
                .iter()
                .all(|p| p.transcript.as_ref().unwrap().seq == 1)
        }) {
            break;
        }
        assert!(
            Instant::now() < idle_deadline,
            "idle sample requires six initial checkpoints before streaming"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    draw(cx);
    let idle = Command::new("ps")
        .args(["-p", &std::process::id().to_string(), "-o", "rss="])
        .output()
        .unwrap();
    let rss = String::from_utf8_lossy(&idle.stdout)
        .trim()
        .parse::<f64>()
        .unwrap()
        / 1024.;
    let mut frames = vec![];
    let mut keys = vec![];
    let mut sequences = vec![1; 6];
    let deadline = Instant::now() + Duration::from_secs(15);
    while frames.len() < 60 {
        assert!(Instant::now() < deadline, "stream measurement deadline");
        grid.update(cx, |g, cx| g.poll(cx));
        let next = grid.read_with(cx, |g, _| {
            g.panes
                .iter()
                .map(|p| p.transcript.as_ref().unwrap().seq)
                .collect::<Vec<_>>()
        });
        if next.iter().zip(&sequences).all(|(a, b)| a > b) {
            grid.update(cx, |g, _| {
                for pane in &mut g.panes {
                    pane.navigate(true);
                    pane.painted_rows.borrow_mut().clear();
                }
            });
            let start = Instant::now();
            draw(cx);
            frames.push(start.elapsed().as_secs_f64() * 1000.);
            grid.read_with(cx, |g, _| {
                for pane in &g.panes {
                    assert!(
                        pane.painted_rows.borrow().contains(&(pane.rows.len() - 1)),
                        "timed draw must paint each changed tail"
                    );
                }
            });
            let start = Instant::now();
            cx.simulate_keystrokes("end");
            draw(cx);
            keys.push(start.elapsed().as_secs_f64() * 1000.);
            grid.read_with(cx, |g, _| {
                assert_eq!(
                    g.panes[g.layout.focus].revision,
                    g.panes[g.layout.focus].painted.get()
                )
            });
            sequences = next;
        } else {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    println!(
        "O8_PANE_GRID_EVIDENCE {}",
        json!({"endpoint":"Linux GPUI TestAppContext CPU scene; no-op text system; no GPU/compositor", "panes":6,
        "viewport":cx.update(|window,_| { let s=window.viewport_size(); json!({"width":f32::from(s.width),"height":f32::from(s.height)}) }),
        "rowsPerPane":100,"streamHzPerPane":20,"idleCheckpointSequence":1,
        "frameMs":frames,"keyToFrameMs":keys,"idleMemoryMiB":rss,"finalSequences":sequences})
    );
}

#[gpui::test]
fn slot_terminal_choice_is_keyboard_reachable_and_persisted(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (grid, cx) = cx.add_window_view(|window, cx| {
        Grid::new(fixture.client.clone(), fixture.options.clone(), window, cx)
    });
    grid.update(cx, |g, cx| g.load(cx));
    cx.run_until_parked();
    draw(cx);
    cx.simulate_keystrokes("ctrl-alt-t");
    let saved: Value = serde_json::from_slice(&fs::read(&fixture.options.file).unwrap()).unwrap();
    assert_eq!(
        saved[&fixture.options.workspace]["views"][0], "terminal",
        "Ctrl+Alt+T must persist the focused slot's terminal choice"
    );
    assert_eq!(saved[&fixture.options.workspace]["views"][1], "transcript");
    cx.simulate_keystrokes("ctrl-alt-t");
    let saved: Value = serde_json::from_slice(&fs::read(&fixture.options.file).unwrap()).unwrap();
    assert_eq!(saved[&fixture.options.workspace]["views"][0], "transcript");
}

#[path = "grid_terminal_tests.rs"]
mod terminals;
