use super::*;
struct SurfaceHooks;
register_shell_feature!(SurfaceHooks);
impl ShellFeature for SurfaceHooks {
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: 10,
            install: |s, window, cx| {
                for registration in registrations() {
                    (registration.initialize)(s, window, cx);
                }
            },
        }]
    }
    fn ticks(&self) -> &'static [TickHook] {
        &[
            TickHook {
                order: 0,
                run: |s, refresh, window, cx| {
                    for extension in registry::extensions() {
                        extension.tick(s, refresh, window, cx);
                    }
                    for registration in registrations() {
                        (registration.tick)(s, window, cx);
                    }
                },
            },
            TickHook {
                order: 200,
                run: |s, refresh, _, cx| {
                    for content in s.content.values() {
                        content.tick(refresh, cx);
                    }
                },
            },
        ]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            bind_root: None,
            order: 0,
            dispatch: |s, event, window, cx| {
                for extension in registry::extensions() {
                    let result = extension.key(s, event, window, cx);
                    if result != KeyResult::Unhandled {
                        return result;
                    }
                }
                KeyResult::Unhandled
            },
        }]
    }
}
