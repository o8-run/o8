//! Which parts of a native visualization stay visible under GPUI's overlays.
//! The macOS host and the visualization check executable both include this file.
/// The parts of `visible` that no `covered` region paints over.
pub fn uncovered(
    visible: gpui::Bounds<gpui::Pixels>,
    covered: &[gpui::Bounds<gpui::Pixels>],
) -> Vec<gpui::Bounds<gpui::Pixels>> {
    use gpui::{Bounds, point};
    let mut parts = vec![visible];
    for cover in covered {
        parts = parts
            .into_iter()
            .flat_map(|part| {
                let overlap = part.intersect(cover);
                if overlap.is_empty() {
                    return vec![part];
                }
                let mut rest = vec![];
                if overlap.top() > part.top() {
                    rest.push(Bounds::from_corners(
                        part.origin,
                        point(part.right(), overlap.top()),
                    ));
                }
                if overlap.bottom() < part.bottom() {
                    rest.push(Bounds::from_corners(
                        point(part.left(), overlap.bottom()),
                        part.bottom_right(),
                    ));
                }
                if overlap.left() > part.left() {
                    rest.push(Bounds::from_corners(
                        point(part.left(), overlap.top()),
                        point(overlap.left(), overlap.bottom()),
                    ));
                }
                if overlap.right() < part.right() {
                    rest.push(Bounds::from_corners(
                        point(overlap.right(), overlap.top()),
                        point(part.right(), overlap.bottom()),
                    ));
                }
                rest
            })
            .collect();
    }
    parts
}
