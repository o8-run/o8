//! Write-path receipt for the Next-stopped switch (#5576): the production shell makes its own
//! writes against the real WS process with Next stopped. A chat send, a settings change, a thread
//! open and archive, and Activity's Stop and archive, each through simulated input on the real
//! shell window (not a display server). Every request goes through the recording relay of
//! tests/o8-next-o8d-write-real-path.test.ts, which runs this test and checks each outcome
//! against the listener. This test only drives and records; the receipt asserts.
use super::*;
use crate::client::Client;
use std::io::Write as _;
use std::time::Duration;

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("{key} is set by the write receipt"))
}
/// Tells the relay which flow the window's next requests belong to.
fn flow(name: &str) {
    println!("o8d-write-flow {name}");
    let _ = std::io::stdout().flush();
}
fn pump(shell: &Entity<Shell>, refresh: bool, cx: &mut VisualTestContext) {
    cx.run_until_parked();
    shell.update_in(cx, |s, window, cx| s.tick(refresh, window, cx));
    draw(cx);
}
/// Runs the window until `done` holds; false when `seconds` pass first.
fn until(
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
    seconds: u64,
    mut done: impl FnMut(&Entity<Shell>, &mut VisualTestContext) -> bool,
) -> bool {
    let started = Instant::now();
    let mut ticks = 0u32;
    loop {
        ticks += 1;
        pump(shell, ticks % 20 == 0, cx);
        if done(shell, cx) {
            return true;
        }
        if started.elapsed() > Duration::from_secs(seconds) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn selector(name: &str) -> &'static str {
    Box::leak(name.to_owned().into_boxed_str())
}
/// A click on a painted control, as a person makes it; false when it is not painted.
fn press(cx: &mut VisualTestContext, name: &str, right: bool) -> bool {
    draw(cx);
    let Some(bounds) = cx.debug_bounds(selector(name)) else {
        return false;
    };
    if right {
        let button = gpui::MouseButton::Right;
        cx.simulate_mouse_down(bounds.center(), button, gpui::Modifiers::default());
        cx.simulate_mouse_up(bounds.center(), button, gpui::Modifiers::default());
    } else {
        cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    }
    cx.run_until_parked();
    draw(cx);
    true
}
/// Scrolls the Activity pane by `step` until `name` is painted; false when it never is.
fn reveal(shell: &Entity<Shell>, cx: &mut VisualTestContext, name: &str, step: f32) -> bool {
    for _ in 0..12 {
        if until(shell, cx, 2, |_, cx| {
            cx.debug_bounds(selector(name)).is_some()
        }) {
            return true;
        }
        if let Some(pane) = cx.debug_bounds("activity-pane") {
            cx.simulate_event(ScrollWheelEvent {
                position: pane.center(),
                delta: ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(step))),
                ..Default::default()
            });
        }
    }
    false
}
fn main_view(shell: &Entity<Shell>, cx: &VisualTestContext) -> Option<Entity<crate::ui::Surface>> {
    shell.read_with(cx, |s, _| match s.content.get(&s.key(&s.active()?)) {
        Some(Content::Session(view)) => Some(view.clone()),
        _ => None,
    })
}
fn main_state(shell: &Entity<Shell>, cx: &VisualTestContext) -> Value {
    main_view(shell, cx).map_or(Value::Null, |view| {
        view.read_with(cx, |v, cx| v.shell_issue_state(cx))
    })
}
fn main_rows(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> u64 {
    main_view(shell, cx).map_or(0, |view| {
        view.update(cx, |v, cx| v.shell_loaded_probe(false, cx))["rows"]
            .as_u64()
            .unwrap_or(0)
    })
}
/// The sidebar row for `id`, scrolled into view.
fn row(shell: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) -> Option<String> {
    let list = shell.read_with(cx, |s, _| s.surfaces.sidebar.view.clone())?;
    let index = list.read_with(cx, |l, _| {
        l.rows.iter().position(|r| r.id.as_deref() == Some(id))
    })?;
    list.update(cx, |l, cx| {
        l.scroll
            .scroll_to_item_strict(index, ScrollStrategy::Center);
        cx.notify();
    });
    draw(cx);
    Some(format!("thread-row-{index}"))
}
fn listed(shell: &Entity<Shell>, cx: &VisualTestContext, id: &str) -> Option<String> {
    let list = shell.read_with(cx, |s, _| s.surfaces.sidebar.view.clone())?;
    list.read_with(cx, |l, _| {
        l.sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.status.clone())
    })
}
fn effort(oracle: &Client) -> Value {
    oracle
        .get::<Value>("/api/panel/operator-defaults", &[("include", "values")])
        .map_or(Value::Null, |defaults| {
            defaults["values"]["thinkingEffort"].clone()
        })
}
fn packet(oracle: &Client, id: &str) -> Value {
    oracle
        .get::<Value>("/api/orchestrator/state", &[])
        .ok()
        .and_then(|state| {
            state["mission"]["packets"]
                .as_array()?
                .iter()
                .find(|p| p["id"] == id)
                .cloned()
        })
        .unwrap_or(Value::Null)
}

#[gpui::test]
#[ignore = "Run only through tests/o8-next-o8d-write-real-path.test.ts with its owned WS process"]
fn o8d_write_receipt(cx: &mut TestAppContext) {
    // The window's client dials the relay; the receipt's own reads go to the listener, so the
    // relay records only what the window sends.
    let client = Client::new(&env("O8_NEXT_WRITE_SERVER")).unwrap();
    let oracle = Client::new(&env("O8_NEXT_WRITE_LISTENER")).unwrap();
    let (prompt, reply) = (env("O8_NEXT_WRITE_PROMPT"), env("O8_NEXT_WRITE_REPLY"));
    let saved = env("O8_NEXT_WRITE_THREAD");
    let packet_id = env("O8_NEXT_WRITE_PACKET");
    let mut receipt = json!({});

    flow("open");
    let state = PathBuf::from(env("O8_NEXT_WRITE_SHELL_STATE"));
    let (shell, mut visual) = open_past_setup(client, state, State::default(), cx);
    let cx = &mut visual;
    // Tall enough that an expanded packet card's controls usually paint without scrolling.
    cx.simulate_resize(gpui::size(gpui::px(1440.), gpui::px(1600.)));
    let opened = until(&shell, cx, 60, |shell, cx| {
        shell.read_with(cx, |s, _| s.connected && s.state.selected.is_some())
            && listed(shell, cx, &saved).is_some()
    });
    let workspace = shell.read_with(cx, |s, _| s.state.selected.clone());
    receipt["open"] = json!({"ready": opened, "workspace": workspace});

    // Sidebar New thread, then a message typed into its composer and sent with Enter.
    flow("chat");
    let thread = shell.update(cx, |s, cx| s.start_thread(true, cx));
    let mut chat = json!({"thread": thread});
    if let Some(thread) = thread {
        chat["opened"] = json!(until(&shell, cx, 30, |shell, cx| {
            let state = main_state(shell, cx);
            state["selected"] == thread.as_str() && state["ready"] == true
        }));
        if let Some(view) = main_view(&shell, cx) {
            view.update_in(cx, |v, window, cx| v.shell_focus(true, window, cx));
            cx.simulate_input(&prompt);
            cx.simulate_keystrokes("enter");
            chat["sent"] = json!(true);
            chat["replied"] = json!(until(&shell, cx, 120, |shell, cx| {
                main_rows(shell, cx) >= 2
                    && oracle.history(&thread).is_ok_and(|history| {
                        history
                            .transcript
                            .iter()
                            .any(|e| e.role == "assistant" && e.text.contains(reply.as_str()))
                    })
            }));
        }
        chat["rows"] = json!(main_rows(&shell, cx));
        chat["state"] = main_state(&shell, cx);
    }
    receipt["chat"] = chat;

    // The composer's effort picker saves the operator default.
    flow("settings");
    let before = effort(&oracle);
    let clicked = press(cx, "composer-effort", false) && press(cx, "effort-high", false);
    let saved_effort = until(&shell, cx, 20, |_, _| effort(&oracle) == "high");
    receipt["settings"] = json!({"before": before, "clicked": clicked, "saved": saved_effort,
        "after": effort(&oracle), "state": main_state(&shell, cx)});

    // Open a saved thread from the sidebar, then archive it from its row menu.
    flow("threads");
    let clicked = row(&shell, cx, &saved).is_some_and(|row| press(cx, &row, false));
    let shown = until(&shell, cx, 30, |shell, cx| {
        let state = main_state(shell, cx);
        state["selected"] == saved.as_str() && state["ready"] == true
    });
    let menu = row(&shell, cx, &saved).is_some_and(|row| press(cx, &row, true))
        && press(cx, "sidebar-row-archive", false);
    // The row leaves the active list or shows as archived once the catalog reloads.
    let archived = until(&shell, cx, 20, |shell, cx| {
        listed(shell, cx, &saved).is_none_or(|status| status == "archived")
    });
    receipt["threads"] = json!({"thread": saved, "clicked": clicked, "opened": shown,
        "archiveClicked": menu, "archived": archived});

    // Activity: the running packet's Archive asks first, then Stop and archive.
    flow("activity");
    // The palette's Open Activity command, run directly: typed palette queries can match other
    // commands as the shell's catalog grows.
    shell.update_in(cx, |s, window, cx| s.execute(Command::Activity, window, cx));
    let pane = until(&shell, cx, 20, |_, cx| {
        cx.debug_bounds("activity-pane").is_some()
    });
    let filtered = press(cx, "activity-filter-packet", false);
    let card = format!("activity-row-packet-local-{packet_id}");
    let shown = until(&shell, cx, 30, |_, cx| {
        cx.debug_bounds(selector(&card)).is_some()
    });
    // The row toggles its card. A card the pane restored open closes on the first click, so a
    // card whose controls never come into view gets one more click.
    let mut clicks = 0;
    let mut offered = false;
    while shown && !offered && clicks < 2 {
        clicks += press(cx, &card, false) as u32;
        offered = reveal(&shell, cx, "activity-packet-archive", -400.);
        if !offered {
            reveal(&shell, cx, &card, 400.);
        }
    }
    let expanded = clicks > 0;
    let painted = json!({"clicks": clicks, "actions": cx.debug_bounds("activity-packet-actions").is_some(),
        "destructive": cx.debug_bounds("activity-packet-destructive").is_some(),
        "stop": cx.debug_bounds("activity-lane-stop").is_some()});
    let asked = offered && press(cx, "activity-packet-archive", false);
    let confirm = cx.debug_bounds("activity-archive-confirm").is_some();
    let confirmed = confirm && press(cx, "activity-archive-stop-confirm", false);
    let settled = until(&shell, cx, 20, |_, _| {
        packet(&oracle, &packet_id)["archivedAt"].is_string()
    });
    receipt["activity"] = json!({"pane": pane, "filtered": filtered, "listed": shown,
        "expanded": expanded, "asked": asked, "confirm": confirm, "confirmed": confirmed,
        "archived": settled, "painted": painted,
        "confirmShown": cx.debug_bounds("activity-archive-confirm").is_some()});

    flow("done");
    fs::write(
        env("O8_NEXT_WRITE_OUTPUT"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
}
