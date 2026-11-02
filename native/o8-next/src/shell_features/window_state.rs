use super::*;
struct WindowState;
register_shell_feature!(WindowState);
#[derive(Default)]
struct Observers {
    subscriptions: Vec<gpui::Subscription>,
}
impl ShellFeature for WindowState {
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: 0,
            install: |shell, window, cx| {
                shell
                    .features
                    .get::<Observers>()
                    .subscriptions
                    .push(cx.observe_window_bounds(window, |this, window, _| {
                        let bounds = window.window_bounds().get_bounds();
                        this.state.bounds = [
                            bounds.origin.x.into(),
                            bounds.origin.y.into(),
                            bounds.size.width.into(),
                            bounds.size.height.into(),
                        ];
                        this.persist();
                    }));
                let view = cx.weak_entity();
                window.on_window_should_close(cx, move |window, cx| {
                    let _ = view.update(cx, |this, cx| {
                        this.capture(window, cx);
                        this.persist();
                    });
                    true
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
                    s.persist();
                }
            },
        }]
    }
}
