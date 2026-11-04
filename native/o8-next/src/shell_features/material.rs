use super::*;
struct Material;
register_shell_feature!(Material);
impl ShellFeature for Material {
    fn observers(&self) -> &'static [PreferenceObserver] {
        // A saved font that is no longer installed runs in its default.
        &[PreferenceObserver {
            order: 0,
            install: |_, window, cx| {
                if crate::theme::check_installed_fonts(&cx.text_system().all_font_names()) {
                    window.refresh();
                }
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
