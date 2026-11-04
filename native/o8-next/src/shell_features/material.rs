use super::*;
struct Material;
register_shell_feature!(Material);
/// Keeps the System appearance choice following the window's appearance.
#[derive(Default)]
struct SystemAppearance(Option<gpui::Subscription>);
fn system_light(window: &Window) -> bool {
    matches!(
        window.appearance(),
        gpui::WindowAppearance::Light | gpui::WindowAppearance::VibrantLight
    )
}
impl ShellFeature for Material {
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: 0,
            install: |shell, window, cx| {
                crate::theme::set_system_light(system_light(window));
                let subscription = cx.observe_window_appearance(window, |s, window, cx| {
                    if crate::theme::set_system_light(system_light(window)) {
                        s.system_glass = crate::shell::material::switch(window, s.offscreen);
                        window.refresh();
                        cx.notify();
                    }
                });
                shell.features.get::<SystemAppearance>().0 = Some(subscription);
            },
        }]
    }
    fn slots(&self) -> &'static [RenderSlot] {
        &[
            RenderSlot {
                group: RenderGroup::Content,
                order: 0,
                render: |s, _, _, _| {
                    s.system_glass
                        .then(|| crate::shell::material::veil().into_any_element())
                },
            },
            RenderSlot {
                group: RenderGroup::Content,
                order: 700,
                render: |s, _, _, _| {
                    let revision = s.revision;
                    let painted = s.painted.clone();
                    Some(
                        canvas(
                            |_, _, _| (),
                            move |_, _, _, _| {
                                if painted.replace(revision) == u64::MAX {
                                    report_startup();
                                }
                            },
                        )
                        .size(px(1.))
                        .into_any_element(),
                    )
                },
            },
        ]
    }
}
