// Only active in the registry integration fixture; other test windows retain their UI.
use super::*;
struct Probe;
register_shell_feature!(Probe);
#[derive(Default)]
struct ChromeState {
    changed: bool,
}
fn active(s: &Shell) -> bool {
    s.file.ends_with("feature-registry.json")
}
static COMMAND: PaletteCommand = PaletteCommand {
    id: "feature-probe",
    label: "Feature probe",
    run: |s, window, cx| {
        s.palette = false;
        s.notice = "feature command".into();
        s.restore_focus(window, cx);
        cx.notify();
    },
};
impl ShellFeature for Probe {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Chrome,
            order: 450,
            render: |s, _, _, _| {
                let changed = s.features.get::<ChromeState>().changed;
                active(s).then(|| {
                    div()
                        .debug_selector(|| "feature-probe".into())
                        .child(
                            div()
                                .debug_selector(move || {
                                    if changed {
                                        "feature-slot-updated"
                                    } else {
                                        "feature-slot-initial"
                                    }
                                    .into()
                                })
                                .w(px(100.))
                                .h(px(24.))
                                .child(if changed {
                                    "Updated slot"
                                } else {
                                    "Initial slot"
                                }),
                        )
                        .into_any_element()
                })
            },
        }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            bind_root: None,
            order: -10,
            dispatch: |s, event, _, _| {
                if active(s) && event.keystroke.modifiers.alt && event.keystroke.key == "c" {
                    s.features.get::<ChromeState>().changed = true;
                    return KeyResult::Handled;
                }
                if active(s) && event.keystroke.modifiers.alt && event.keystroke.key == "u" {
                    s.notice = "feature key".into();
                    KeyResult::Handled
                } else {
                    KeyResult::Unhandled
                }
            },
        }]
    }
    fn commands(&self) -> &'static [PaletteCommands] {
        &[PaletteCommands {
            order: 50,
            collect: |s| {
                if active(s) {
                    vec![Command::Feature(&COMMAND)]
                } else {
                    vec![]
                }
            },
        }]
    }
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 300,
            run: |s, _, _, _| {
                if active(s) {
                    s.notice = "feature tick".into();
                }
            },
        }]
    }
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: 100,
            install: |s, window, cx| {
                if active(s) {
                    s.subscriptions
                        .push(cx.observe_window_bounds(window, |s, _, _| {
                            s.notice = "feature observer".into()
                        }));
                }
            },
        }]
    }
}
