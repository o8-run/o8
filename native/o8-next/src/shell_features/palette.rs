use super::*;
struct Palette;
register_shell_feature!(Palette);
impl ShellFeature for Palette {
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 50,
            dispatch: super::super::palette::key,
        }]
    }
    fn slots(&self) -> &'static [RenderSlot] {
        // A floating card over the workspace, so it renders with the content's
        // overlays rather than inside the measured header.
        &[RenderSlot {
            group: RenderGroup::Content,
            order: 930,
            render: |s, _, _, cx| {
                if !s.palette {
                    return None;
                }
                registry::extensions()
                    .find_map(|extension| extension.palette(s, cx))
                    .or_else(|| super::super::palette::render(s, cx))
            },
        }]
    }
}
