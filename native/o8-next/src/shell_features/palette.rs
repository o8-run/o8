use super::*;
struct Palette;
register_shell_feature!(Palette);
impl ShellFeature for Palette {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Chrome,
            order: 400,
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
