use crate::shell::{test_support::*, *};

fn toggle(cx: &mut VisualTestContext) {
    draw(cx);
    let bounds = cx
        .debug_bounds("speed-toggle")
        .expect("Experimental speed control");
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn speed_overlay_is_opt_in_compact_and_preserves_composer_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("state.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    assert!(cx.debug_bounds("speed-panel").is_none());
    // Exercise actual shell command dispatch and the platform input contract.
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    ready(&shell, cx);
    toggle(cx);
    let bounds = cx.debug_bounds("speed-panel").expect("one compact panel");
    assert!(
        bounds.size.width <= px(200.) && bounds.size.height <= px(64.),
        "numbers-only panel must fit two rows"
    );
    for selector in ["speed-key", "speed-frame", "speed-wakeups", "speed-memory"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    let key = cx.debug_bounds("speed-key").unwrap();
    let frame = cx.debug_bounds("speed-frame").unwrap();
    let wakeups = cx.debug_bounds("speed-wakeups").unwrap();
    let memory = cx.debug_bounds("speed-memory").unwrap();
    assert_eq!(key.origin.x, wakeups.origin.x);
    assert_eq!(frame.origin.x, memory.origin.x);
    assert_eq!(key.origin.y, frame.origin.y);
    assert_eq!(wakeups.origin.y, memory.origin.y);
    assert!(frame.origin.x > key.origin.x && wakeups.origin.y > key.origin.y);
    cx.simulate_input("fixture draft");
    draw(cx);
    shell.read_with(cx, |s, cx| {
        let content = s.content.get(&s.key(&s.active().unwrap())).unwrap();
        let Content::Session(view) = content else {
            panic!("session surface")
        };
        assert_eq!(
            view.read(cx).shell_issue_state(cx)["draft"],
            "fixture draft"
        );
    });
    toggle(cx);
    assert!(
        !shell.read_with(cx, |s, _| s.surfaces.speed.sample.borrow().enabled),
        "toggle must disable the probe"
    );
    cx.simulate_input(" retained");
    draw(cx);
    shell.read_with(cx, |s, cx| {
        let Content::Session(view) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        assert_eq!(
            view.read(cx).shell_issue_state(cx)["draft"],
            "fixture draft retained"
        );
    });
}

#[gpui::test]
fn speed_overlay_keyboard_toggle_restores_composer(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("focus.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    ready(&shell, cx);
    for (index, shortcut) in ["ctrl-k", "cmd-k"].into_iter().enumerate() {
        cx.simulate_keystrokes(shortcut);
        shell.update_in(cx, |s, window, cx| s.execute(Command::Speed, window, cx));
        draw(cx);
        cx.simulate_input("a");
        shell.read_with(cx, |s, cx| {
            let Content::Session(view) = s.content.get(&s.key(&s.active().unwrap())).unwrap()
            else {
                panic!("session")
            };
            assert_eq!(
                view.read(cx).shell_issue_state(cx)["draft"],
                "a".repeat(index + 1),
                "keyboard opt-in must restore composer focus"
            );
        });
    }
}

#[gpui::test]
fn speed_overlay_discards_focus_changes_and_bounds_samples(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("samples.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    ready(&shell, cx);
    toggle(cx);
    let focus = shell.read_with(cx, |s, _| s.focus.clone());
    cx.update(|window, cx| {
        window.dispatch_keystroke(gpui::Keystroke::parse("a").unwrap(), cx);
        focus.focus(window);
    });
    draw(cx);
    shell.read_with(cx, |s, _| {
        assert!(
            s.surfaces.speed.sample.borrow().key_ms.is_empty(),
            "a focus change must discard pending input"
        )
    });
    shell.update_in(cx, |s, window, cx| s.restore_focus(window, cx));
    for _ in 0..80 {
        cx.simulate_keystrokes("a");
        draw(cx);
    }
    shell.read_with(cx, |s, _| {
        let sample = s.surfaces.speed.sample.borrow();
        assert!(sample.frame_ms.len() <= 64);
        assert_eq!(sample.key_ms.len(), 64);
        println!("O8_NEXT_SPEED {}", json!({"keyToCpuPaintMs":sample.key_ms.back(),"frameToCpuPaintMs":sample.frame_ms.back(),"retainedSamples":sample.key_ms.len()}));
    });
    toggle(cx);
    draw(cx);
    shell.read_with(cx, |s, _| {
        let sample = s.surfaces.speed.sample.borrow();
        assert!(sample.key_ms.is_empty() && sample.frame_ms.is_empty());
    });
}

#[gpui::test]
fn speed_overlay_ignores_memory_completion_from_a_previous_opt_in(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("race.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    toggle(cx);
    shell.update_in(cx, |s, window, cx| {
        s.tick(false, window, cx);
        s.execute(Command::Speed, window, cx);
        s.execute(Command::Speed, window, cx);
    });
    cx.run_until_parked();
    draw(cx);
    shell.read_with(cx, |s, _| {
        let sample = s.surfaces.speed.sample.borrow();
        assert!(sample.enabled);
        assert!(
            sample.memory_mib.is_none(),
            "previous generation must not publish memory"
        );
        assert!(!sample.memory_pending);
    });
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    cx.run_until_parked();
    let sampled_at = shell.read_with(cx, |s, _| s.surfaces.speed.sample.borrow().memory_at);
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    assert_eq!(
        sampled_at,
        shell.read_with(cx, |s, _| s.surfaces.speed.sample.borrow().memory_at)
    );
    shell.read_with(cx, |s, _| {
        assert!(
            s.surfaces
                .speed
                .sample
                .borrow()
                .memory_mib
                .is_some_and(|v| v > 0. && v.is_finite())
        )
    });
    toggle(cx);
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    cx.run_until_parked();
    shell.read_with(cx, |s, _| {
        let sample = s.surfaces.speed.sample.borrow();
        assert!(
            sample.memory_at.is_none() && sample.memory_mib.is_none(),
            "hidden panel must not sample"
        );
    });
}

#[gpui::test]
fn speed_overlay_reopen_does_not_restore_old_samples_or_save_opt_in(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("state.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    let cx = &mut visual;
    ready(&shell, cx);
    toggle(cx);
    cx.simulate_keystrokes("ctrl-k a");
    draw(cx);
    toggle(cx);
    toggle(cx);
    let bytes = fs::read_to_string(&file).unwrap();
    assert!(!bytes.contains("speed"), "opt-in must be process local");
    toggle(cx);
    // Reopening the actual window starts off, including on macOS canonical temp paths.
    let state = State::load(&fs::canonicalize(file).unwrap()).unwrap();
    let (_second, mut second_cx) = open(
        fixture.client.clone(),
        fixture.root.join("second.json"),
        state,
        cx,
    );
    second_cx.run_until_parked();
    draw(&mut second_cx);
    assert!(second_cx.debug_bounds("speed-panel").is_none());
}

#[test]
fn speed_overlay_reads_memory_without_a_helper_process() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("o8-speed-no-helper-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let marker = root.join("helper-started");
    let trap = root.join("ps");
    fs::write(
        &trap,
        "#!/bin/sh\n: > \"$O8_SPEED_HELPER_MARKER\"\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&trap, fs::Permissions::from_mode(0o700)).unwrap();
    let path = std::env::join_paths(
        std::iter::once(root.clone())
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let output = Process::new(std::env::current_exe().unwrap())
        .args([
            "shell::speed::tests::speed_overlay_ignores_memory_completion_from_a_previous_opt_in",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("PATH", path)
        .env("O8_SPEED_HELPER_MARKER", &marker)
        .output()
        .unwrap();
    let helper_started = marker.exists();
    fs::remove_dir_all(root).unwrap();
    assert!(
        !helper_started,
        "visible overlay must not spawn a process for sampling"
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

// Opt-in receipt: real shell tick cadence, no physical display or OS event loop.
#[gpui::test]
#[ignore]
fn speed_overlay_idle_cpu_receipt(cx: &mut TestAppContext) {
    fn cpu() -> f64 {
        [libc::RUSAGE_SELF, libc::RUSAGE_CHILDREN]
            .into_iter()
            .map(|who| {
                let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
                assert_eq!(unsafe { libc::getrusage(who, usage.as_mut_ptr()) }, 0);
                let usage = unsafe { usage.assume_init() };
                usage.ru_utime.tv_sec as f64
                    + usage.ru_utime.tv_usec as f64 / 1e6
                    + usage.ru_stime.tv_sec as f64
                    + usage.ru_stime.tv_usec as f64 / 1e6
            })
            .sum()
    }
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("idle.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let mut measurements = Vec::new();
    for enabled in [false, true, false, true] {
        if enabled != shell.read_with(cx, |s, _| s.surfaces.speed.sample.borrow().enabled) {
            toggle(cx);
        }
        // Settle initial fixture work and the toggle before each timed span.
        for tick in 0..150 {
            shell.update_in(cx, |s, window, cx| s.tick(tick % 50 == 0, window, cx));
            cx.run_until_parked();
            if tick % 50 == 0 {
                draw(cx);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let start = Instant::now();
        let before = cpu();
        for tick in 0..500 {
            shell.update_in(cx, |s, window, cx| s.tick(tick % 50 == 0, window, cx));
            cx.run_until_parked();
            // The shell callback invalidates the visible panel at most once/sec.
            if tick % 50 == 0 {
                draw(cx);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        measurements.push(json!({"enabled":enabled,"cpuPercent":(cpu()-before)/start.elapsed().as_secs_f64()*100.,"wallSeconds":start.elapsed().as_secs_f64()}));
    }
    println!(
        "O8_SPEED_IDLE_CPU {}",
        json!({"scope":"shell test process plus reaped helpers; owned live fixture server excluded; 50 callbacks/s; debug CPU scene", "samples":measurements})
    );
}
