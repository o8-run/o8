use super::*;
struct Material;
register_shell_feature!(Material);
impl ShellFeature for Material {
    fn slots(&self) -> &'static [RenderSlot] {
        &[
            RenderSlot {
                order: 0,
                render: |s, _, _, _| {
                    s.system_glass
                        .then(|| crate::shell::material::veil().into_any_element())
                },
            },
            RenderSlot {
                order: 700,
                render: |s, _, _, _| {
                    let revision = s.revision;
                    let painted = s.painted.clone();
                    Some(
                        canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision))
                            .size(px(1.))
                            .into_any_element(),
                    )
                },
            },
        ]
    }
}
