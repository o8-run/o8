//! Read-only geometry equivalent to HoverPipCard's textarea measurement.
use super::*;
impl Surface {
    pub(crate) fn browser_composer_bounds(
        &self,
        cx: &gpui::App,
    ) -> Option<gpui::Bounds<gpui::Pixels>> {
        let bounds = self.composer.read(cx).preview_obstacle();
        (bounds.size.width > px(1.) && bounds.size.height > px(1.)).then_some(bounds)
    }
}
