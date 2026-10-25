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

// Opt-in receipt: >=60 seconds in each state, notification-driven CPU scenes.
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
    fn watch<T: 'static>(
        entity: &Entity<T>,
        cx: &mut VisualTestContext,
        dirty: Rc<Cell<bool>>,
        count: Rc<Cell<u64>>,
        painted: Rc<Cell<u64>>,
    ) -> gpui::Subscription {
        cx.update(|_, cx| {
            cx.observe(entity, move |_, _| {
                dirty.set(true);
                painted.set(u64::MAX);
                count.set(count.get() + 1);
            })
        })
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
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    ready(&shell, cx);
    let session = shell.read_with(cx, |s, _| {
        let Content::Session(view) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        view.clone()
    });
    let composer = session.read_with(cx, |s, _| s.shell_composer());
    let painted = shell.read_with(cx, |s, _| s.painted.clone());
    let dirty = Rc::new(Cell::new(false));
    let shell_notifications = Rc::new(Cell::new(0));
    let other_notifications = Rc::new(Cell::new(0));
    let _watches = [
        watch(
            &shell,
            cx,
            dirty.clone(),
            shell_notifications.clone(),
            painted.clone(),
        ),
        watch(
            &session,
            cx,
            dirty.clone(),
            other_notifications.clone(),
            painted.clone(),
        ),
        watch(
            &composer,
            cx,
            dirty.clone(),
            other_notifications.clone(),
            painted.clone(),
        ),
    ];
    let mut measurements = Vec::new();
    // ABBA order reduces linear warmup/load drift; each state totals >=60 sec.
    for enabled in [false, true, true, false] {
        if enabled != shell.read_with(cx, |s, _| s.surfaces.speed.sample.borrow().enabled) {
            toggle(cx);
        }
        let readout_notifications = Rc::new(Cell::new(0));
        let _readout_watch = shell
            .read_with(cx, |s, _| s.surfaces.speed.readout.clone())
            .map(|view| {
                watch(
                    &view,
                    cx,
                    dirty.clone(),
                    readout_notifications.clone(),
                    painted.clone(),
                )
            });
        let mut tick = 0;
        let settle = Instant::now();
        while settle.elapsed() < Duration::from_secs(3) {
            shell.update_in(cx, |s, window, cx| s.tick(tick % 50 == 0, window, cx));
            cx.run_until_parked();
            if dirty.replace(false) && painted.get() == u64::MAX {
                cx.update(|window, cx| window.draw(cx).clear());
            }
            tick += 1;
            std::thread::sleep(Duration::from_millis(20));
        }
        shell_notifications.set(0);
        readout_notifications.set(0);
        let start = Instant::now();
        let before = cpu();
        let mut draws = 0;
        while start.elapsed() < Duration::from_secs(30) {
            shell.update_in(cx, |s, window, cx| s.tick(tick % 50 == 0, window, cx));
            cx.run_until_parked();
            if dirty.replace(false) && painted.get() == u64::MAX {
                cx.update(|window, cx| window.draw(cx).clear());
                draws += 1;
            }
            tick += 1;
            std::thread::sleep(Duration::from_millis(20));
        }
        let cpu_seconds = cpu() - before;
        let wall_seconds = start.elapsed().as_secs_f64();
        let span = json!({"enabled":enabled,"cpuPercent":cpu_seconds/wall_seconds*100.,"cpuSeconds":cpu_seconds,"wallSeconds":wall_seconds,
            "explicitDraws":draws,"shellNotifications":shell_notifications.get(),"readoutNotifications":readout_notifications.get()});
        println!("O8_SPEED_IDLE_SPAN {span}");
        measurements.push(span);
    }
    println!(
        "O8_SPEED_IDLE_CPU {}",
        json!({"platform":std::env::consts::OS,"scope":"shell test process plus reaped helpers; live owned fixture server excluded; 20ms tick target; notification-driven CPU scenes; no GPU or compositor", "samples":measurements})
    );
}

#[gpui::test]
fn speed_overlay_samples_never_invalidate_shell_or_repaint_session(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("sample-paint.json"),
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
    let session = shell.read_with(cx, |s, _| {
        let Content::Session(view) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        view.clone()
    });
    let composer = session.read_with(cx, |s, _| s.shell_composer());
    // Settle the selection's queue/context completions before isolating samples.
    for _ in 0..3 {
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear());
    }
    let notifications = Rc::new(Cell::new(0));
    let _watch = cx.update(|_, cx| {
        cx.observe(&shell, {
            let notifications = notifications.clone();
            move |_, _| notifications.set(notifications.get() + 1)
        })
    });
    composer.update(cx, |input, _| input.painted = u64::MAX);
    cx.update(|window, cx| window.draw(cx).clear());
    composer.read_with(cx, |input, _| {
        assert_eq!(
            input.painted,
            u64::MAX,
            "unchanged window must reuse session"
        )
    });
    let content_notifications = Rc::new(Cell::new(0));
    let _content_watch = cx.update(|_, cx| {
        cx.observe(&session, {
            let count = content_notifications.clone();
            move |_, _| count.set(count.get() + 1)
        })
    });
    let input_notifications = Rc::new(Cell::new(0));
    let _input_watch = cx.update(|_, cx| {
        cx.observe(&composer, {
            let count = input_notifications.clone();
            move |_, _| count.set(count.get() + 1)
        })
    });
    for _ in 0..3 {
        shell.update_in(cx, |s, window, cx| {
            s.surfaces.speed.sample.borrow_mut().memory_at = None;
            let _ = window;
            (super::REGISTRATION.tick)(s, cx);
        });
        cx.run_until_parked();
        assert_eq!(
            notifications.get(),
            0,
            "sampling must never invalidate the shell"
        );
        assert_eq!(
            content_notifications.get(),
            0,
            "sample content notifications"
        );
        assert_eq!(input_notifications.get(), 0, "sample input notifications");
        composer.update(cx, |input, _| input.painted = u64::MAX);
        cx.update(|window, cx| window.draw(cx).clear());
        composer.read_with(cx, |input, _| {
            assert_eq!(
                input.painted,
                u64::MAX,
                "sampling must reuse the session scene"
            )
        });
    }
    cx.simulate_keystrokes("a");
    cx.update(|window, cx| window.draw(cx).clear());
    composer.read_with(cx, |input, _| {
        assert_eq!(input.text, "a");
        assert_eq!(
            input.painted, input.revision,
            "genuine input must invalidate the cached session"
        );
    });
    shell.read_with(cx, |s, _| {
        assert_eq!(s.surfaces.speed.sample.borrow().key_ms.len(), 1)
    });
}

#[gpui::test]
fn speed_overlay_only_invalidates_readout_for_changed_formatted_values(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("unchanged.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    toggle(cx);
    let seed = |value: f64, s: &mut Shell, cx: &mut Context<Shell>| {
        let mut sample = s.surfaces.speed.sample.borrow_mut();
        sample.frame_ms.clear();
        sample.frame_ms.push_back(value);
        sample.last_input = Some(Instant::now());
        sample.memory_at = Some(Instant::now());
        sample.memory_mib = Some(24.);
        sample.dirty = true;
        drop(sample);
        (super::REGISTRATION.tick)(s, cx);
    };
    shell.update_in(cx, |s, _, cx| seed(3.0001, s, cx));
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear());
    let readout = shell.read_with(cx, |s, _| s.surfaces.speed.readout.clone().unwrap());
    let counts = Rc::new(Cell::new((0, 0)));
    let _shell_watch = cx.update(|_, cx| {
        cx.observe(&shell, {
            let counts = counts.clone();
            move |_, _| {
                let (shell, view) = counts.get();
                counts.set((shell + 1, view));
            }
        })
    });
    let _readout_watch = cx.update(|_, cx| {
        cx.observe(&readout, {
            let counts = counts.clone();
            move |_, _| {
                let (shell, view) = counts.get();
                counts.set((shell, view + 1));
            }
        })
    });
    shell.update_in(cx, |s, _, cx| seed(3.0002, s, cx));
    cx.run_until_parked();
    assert_eq!(
        counts.get(),
        (0, 0),
        "identical displayed values must not invalidate anything"
    );
    shell.update_in(cx, |s, _, cx| seed(3.01, s, cx));
    cx.run_until_parked();
    assert_eq!(
        counts.get(),
        (0, 1),
        "changed values must invalidate only the readout"
    );
    let frames = shell.read_with(cx, |s, _| s.surfaces.speed.sample.borrow().frame_ms.len());
    // Test input dispatch may have already serviced the queued window frame.
    if shell.read_with(cx, |s, _| s.surfaces.speed.sample.borrow().readout_frame) {
        cx.update(|window, cx| window.draw(cx).clear());
    }
    assert_eq!(
        frames,
        shell.read_with(cx, |s, _| s.surfaces.speed.sample.borrow().frame_ms.len()),
        "readout paint must not feed another frame sample"
    );
    shell.update_in(cx, |s, _, cx| (super::REGISTRATION.tick)(s, cx));
    cx.run_until_parked();
    assert_eq!(
        counts.get(),
        (0, 1),
        "a readout frame must not publish a feedback sample"
    );
}
