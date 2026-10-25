//! Loaded typing through the packaged shell's actual session registration.
use super::super::{test_support::*, *};

fn loaded_shell(
    cx: &mut TestAppContext,
) -> (
    Fixture,
    Entity<Shell>,
    Entity<crate::ui::Surface>,
    VisualTestContext,
) {
    let fixture = Fixture::start_mode(false, "--composer-loaded");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("state.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(
            Command::Message("thoughts-composer-loaded".into()),
            window,
            cx,
        )
    });
    ready(&shell, &mut visual);
    let session = shell.read_with(&visual, |s, _| {
        match &s.content[&s.key(&s.active().unwrap())] {
            Content::Session(s) => s.clone(),
            _ => panic!("production session registration"),
        }
    });
    session.update(&mut visual, |s, cx| {
        s.shell_loaded_probe(true, cx);
    });
    visual.run_until_parked();
    draw(&mut visual);
    session.update_in(&mut visual, |s, window, cx| {
        assert_eq!(s.shell_loaded_probe(false, cx)["rows"], 200);
        s.shell_focus(true, window, cx);
    });
    draw(&mut visual);
    (fixture, shell, session, visual)
}

#[gpui::test]
fn native_composer_loaded_shell_typing_benchmark(cx: &mut TestAppContext) {
    let (_fixture, shell, session, mut cx) = loaded_shell(cx);
    let notifications = Rc::new(Cell::new(0));
    let observed = notifications.clone();
    let _shell =
        cx.update(|_, cx| cx.observe(&shell, move |_, _| observed.set(observed.get() + 1)));
    let observed = notifications.clone();
    let _session =
        cx.update(|_, cx| cx.observe(&session, move |_, _| observed.set(observed.get() + 1)));
    let regions = session.update(&mut cx, |s, cx| {
        s.shell_loaded_probe(false, cx)["regions"].clone()
    });
    let chrome = shell.read_with(&cx, |s, cx| s.chrome.renders(cx));
    let mut samples = Vec::with_capacity(100);
    for count in 1..=100 {
        let started = Instant::now();
        cx.update(|window, cx| {
            window.dispatch_keystroke(gpui::Keystroke::parse("a").unwrap(), cx);
        });
        samples.push(started.elapsed().as_secs_f64() * 1000.);
        assert_eq!(
            notifications.get(),
            0,
            "typing must not notify the shell or session"
        );
        session.update(&mut cx, |s, cx| {
            let state = s.shell_loaded_probe(false, cx);
            assert_eq!(state["text"].as_str().unwrap().len(), count);
            assert_eq!(
                state["revision"], state["painted"],
                "first scene must paint the edit"
            );
            assert_eq!(
                state["regions"], regions,
                "shell typing must reuse unchanged session regions"
            );
        });
        assert_eq!(
            shell.read_with(&cx, |s, cx| s.chrome.renders(cx)),
            chrome,
            "typing must reuse the shell chrome scene"
        );
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "LOADED_SHELL_CPU_SCENE platform={} profile={} messages=200 inputs=100 p50_ms={:.6} p95_ms={:.6}",
        std::env::consts::OS,
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        samples[49],
        samples[94]
    );
}
