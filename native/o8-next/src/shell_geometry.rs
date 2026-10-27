//! Window geometry uses outer bounds in state and content sizes at the platform resize boundary.
use gpui::{Bounds, Pixels, Size, Window, point, px, size};

pub(super) trait Frame {
    fn outer_size(&self) -> Size<Pixels>;
    fn content_size(&self) -> Size<Pixels>;
    fn resize_content(&mut self, size: Size<Pixels>);
}
impl Frame for Window {
    fn outer_size(&self) -> Size<Pixels> {
        self.window_bounds().get_bounds().size
    }
    fn content_size(&self) -> Size<Pixels> {
        self.viewport_size()
    }
    fn resize_content(&mut self, size: Size<Pixels>) {
        self.resize(size);
    }
}
pub(super) fn restore_size(frame: &mut impl Frame, saved_outer: Size<Pixels>) {
    let outer = frame.outer_size();
    let content = frame.content_size();
    frame.resize_content(size(
        saved_outer.width - (outer.width - content.width).max(px(0.)),
        saved_outer.height - (outer.height - content.height).max(px(0.)),
    ));
}

pub(super) fn visible(bounds: Bounds<Pixels>, displays: &[Bounds<Pixels>]) -> Bounds<Pixels> {
    let overlap = |display: &Bounds<Pixels>| {
        let w =
            (bounds.right().min(display.right()) - bounds.left().max(display.left())).max(px(0.));
        let h =
            (bounds.bottom().min(display.bottom()) - bounds.top().max(display.top())).max(px(0.));
        f32::from(w) * f32::from(h)
    };
    let distance = |display: &Bounds<Pixels>| {
        let dx = f32::from(bounds.left() - bounds.left().clamp(display.left(), display.right()));
        let dy = f32::from(bounds.top() - bounds.top().clamp(display.top(), display.bottom()));
        dx * dx + dy * dy
    };
    let Some(display) = displays
        .iter()
        .filter(|display| display.size.width > px(0.) && display.size.height > px(0.))
        .max_by(|a, b| {
            overlap(a)
                .total_cmp(&overlap(b))
                .then_with(|| distance(b).total_cmp(&distance(a)))
        })
    else {
        return bounds;
    };
    let width = bounds.size.width.min(display.size.width);
    let height = bounds.size.height.min(display.size.height);
    Bounds::new(
        point(
            bounds.left().clamp(display.left(), display.right() - width),
            bounds.top().clamp(display.top(), display.bottom() - height),
        ),
        size(width, height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{px, size};
    struct DecoratedFrame {
        content: Size<Pixels>,
        decoration: Size<Pixels>,
    }
    impl Frame for DecoratedFrame {
        fn outer_size(&self) -> Size<Pixels> {
            size(
                self.content.width + self.decoration.width,
                self.content.height + self.decoration.height,
            )
        }
        fn content_size(&self) -> Size<Pixels> {
            self.content
        }
        fn resize_content(&mut self, size: Size<Pixels>) {
            self.content = size;
        }
    }
    #[test]
    fn correction_restores_saved_outer_height_without_adding_the_titlebar() {
        let saved = size(px(900.), px(700.));
        for decoration in [
            size(px(0.), px(0.)),
            size(px(0.), px(32.)),
            size(px(12.), px(28.)),
        ] {
            let mut frame = DecoratedFrame {
                content: saved,
                decoration,
            };
            for _ in 0..3 {
                restore_size(&mut frame, saved);
                assert_eq!(
                    frame.outer_size(),
                    saved,
                    "restore must preserve the saved outer size across repeated restarts"
                );
            }
        }
    }
    #[test]
    fn correction_display_changes_keep_the_window_visible() {
        let rect = |x, y, w, h| Bounds::new(point(px(x), px(y)), size(px(w), px(h)));
        let display = rect(0., 0., 2560., 1440.);
        assert_eq!(
            visible(rect(3560., 100., 900., 700.), &[display]),
            rect(1660., 100., 900., 700.)
        );
        let negative = rect(-2560., 0., 2560., 1440.);
        let saved = rect(-2100., 100., 900., 700.);
        assert_eq!(visible(saved, &[negative, display]), saved);
        assert_eq!(visible(rect(100., 100., 4000., 3000.), &[display]), display);
        let second = rect(2560., 0., 1920., 1080.);
        assert_eq!(
            visible(rect(2400., 100., 900., 700.), &[display, second]),
            rect(2560., 100., 900., 700.)
        );
    }
}
