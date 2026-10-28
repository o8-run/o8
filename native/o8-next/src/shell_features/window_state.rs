use super::*;
#[path = "window_state/writer.rs"]
mod writer;
struct WindowState;
register_shell_feature!(WindowState);
#[derive(Default)]
struct Runtime {
    writer: Option<writer::Writer>,
    closing: bool,
    subscriptions: Vec<gpui::Subscription>,
}
impl ShellFeature for WindowState {
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: 0,
            install: |shell, window, cx| {
                let (writer, errors) = writer::Writer::new(shell.file.clone());
                shell.features.get::<Runtime>().writer = Some(writer);
                cx.spawn(async move |this, cx| {
                    while let Ok(error) = errors.recv().await {
                        if this
                            .update(cx, |s, cx| {
                                s.notice = format!("{error}. View state remains in memory.");
                                cx.notify();
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                })
                .detach();
                shell
                    .features
                    .get::<Runtime>()
                    .subscriptions
                    .push(cx.observe_window_bounds(window, |s, window, _| {
                        capture_bounds(s, window);
                        persist(s);
                    }));
                let view = cx.weak_entity();
                window.on_window_should_close(cx, move |window, cx| {
                    let _ = view.update(cx, |s, cx| close(s, window, cx));
                    false
                });
            },
        }]
    }
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 100,
            run: |s, _, window, cx| {
                let before = serde_json::to_vec(&s.state).unwrap();
                s.capture(window, cx);
                if before != serde_json::to_vec(&s.state).unwrap() {
                    persist(s);
                }
            },
        }]
    }
}
pub(crate) fn persist(s: &mut Shell) {
    let snapshot = s.state.clone();
    s.features
        .get::<Runtime>()
        .writer
        .as_ref()
        .expect("window-state observer installs the writer before surface initialization")
        .submit(snapshot);
}
fn capture_bounds(s: &mut Shell, window: &Window) {
    let bounds = window.window_bounds().get_bounds();
    s.state.bounds = [
        bounds.origin.x.into(),
        bounds.origin.y.into(),
        bounds.size.width.into(),
        bounds.size.height.into(),
    ];
}
fn close(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if s.features.get::<Runtime>().closing {
        return;
    }
    s.features.get::<Runtime>().closing = true;
    capture_bounds(s, window);
    s.capture(window, cx);
    // Compare every persisted field to the snapshot actually submitted, rather
    // than to in-memory bounds at completion. Input remains live during I/O.
    let submitted = serde_json::to_vec(&s.state).unwrap();
    let snapshot = s.state.clone();
    let saved = s
        .features
        .get::<Runtime>()
        .writer
        .as_ref()
        .unwrap()
        .flush(snapshot);
    cx.spawn_in(window, async move |this, cx| {
        let result = saved
            .recv()
            .await
            .unwrap_or_else(|_| Err("Shell state writer unavailable".into()));
        let _ = this.update_in(cx, |s, window, cx| {
            s.features.get::<Runtime>().closing = false;
            match result {
                Ok(()) => {
                    capture_bounds(s, window);
                    s.capture(window, cx);
                    let unchanged = submitted == serde_json::to_vec(&s.state).unwrap();
                    if unchanged
                        && s.features
                            .get::<Runtime>()
                            .writer
                            .as_ref()
                            .unwrap()
                            .is_idle()
                    {
                        window.remove_window();
                    } else {
                        close(s, window, cx);
                    }
                }
                Err(error) => {
                    s.notice =
                        format!("{error}. View state remains in memory. Close again to retry.");
                    cx.notify();
                }
            }
        });
    })
    .detach();
}
#[cfg(test)]
fn idle(s: &Shell) -> bool {
    s.features
        .read::<Runtime>()
        .and_then(|r| r.writer.as_ref())
        .is_none_or(|w| w.is_idle())
}
// Fixture settling is outside the native input callback. Explicit fault-injection
// tests keep the writer held and drive the raw close request instead.
#[cfg(test)]
pub(crate) fn settle_test_window(shell: &Entity<Shell>, cx: &mut gpui::VisualTestContext) {
    if shell.read_with(cx, |s, _| crate::shell_state::barrier::is_held(&s.file)) {
        return;
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !shell.read_with(cx, |s, _| idle(s)) && std::time::Instant::now() < deadline {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        shell.read_with(cx, |s, _| idle(s)),
        "fixture state writes must settle"
    );
}
#[cfg(test)]
#[path = "window_state/tests.rs"]
mod tests;
