//! A narrow, vertically scrollable graph using the transcript's native painter.
use super::*;

pub(crate) fn drawing(count: usize, edges: Vec<(usize, usize, String)>) -> AnyElement {
    gpui::canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let origin = bounds.origin;
            for (from, to, state) in &edges {
                let y1 = *from as f32 * 36. + 18.;
                let y2 = *to as f32 * 36. + 18.;
                let x = 8. + ((*from + *to) % 4) as f32 * 6.;
                let mut line = PathBuilder::stroke(px(1.));
                line.move_to(origin + point(px(36.), px(y1)));
                line.line_to(origin + point(px(x), px(y1)));
                line.line_to(origin + point(px(x), px(y2)));
                line.line_to(origin + point(px(34.), px(y2)));
                if let Ok(path) = line.build() {
                    window.paint_path(
                        path,
                        match state.as_str() {
                            "added" => theme().success,
                            "removed" => theme().danger,
                            _ => theme().text_muted,
                        },
                    );
                }
                paint_marker(
                    Marker::Arrow,
                    origin + point(px(36.), px(y2)),
                    0.,
                    4.,
                    window,
                );
            }
            for index in 0..count {
                paint_shape(
                    BoxRect {
                        x: 36.,
                        y: index as f32 * 36. + 2.,
                        w: (f32::from(bounds.size.width) - 44.).max(0.),
                        h: 32.,
                    },
                    Shape::Round,
                    origin,
                    window,
                );
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .w_full()
    .h(px(count as f32 * 36.))
    .into_any_element()
}
