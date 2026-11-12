//! Ring, o8's logo, drawn natively from docs/design/BRAND.md §3 (the files in
//! `brand/ring/`): a heavy o, outer radius 40 and inner 22 on a 100×100 box,
//! with an orange review point (r 7.4) on the mid-line (r 31) at −45° and a
//! real 3.4 gap cut out of the ring around it. Flat: no glow, no shadow.
//!
//! The cut circle (r 7.4 + 3.4) crosses both edges of the ring, so the ring is
//! one closed outline of four arcs: the outer edge the long way round, the cut
//! inward, the inner edge back the long way, and the cut outward.
use gpui::{
    App, Bounds, IntoElement, PathBuilder, Pixels, Rgba, Styled, Window, canvas, point, px, rgb,
};

const CENTRE: f32 = 50.;
pub(crate) const OUTER: f32 = 40.;
pub(crate) const INNER: f32 = 22.;
pub(crate) const POINT_R: f32 = 7.4;
pub(crate) const MID: f32 = 31.;
pub(crate) const GAP: f32 = 3.4;
/// −45°: upper right, in the box's y-down coordinates.
const POINT_ANGLE: f32 = -std::f32::consts::FRAC_PI_4;

/// brand/tokens ink, paper and orange.
const INK: u32 = 0x17140F;
const PAPER: u32 = 0xF4F2EC;
const ORANGE: u32 = 0xFF5A1F;

/// The review point's centre: (71.92, 28.08), as in ring-light.svg.
pub(crate) fn point_centre() -> (f32, f32) {
    let (s, c) = POINT_ANGLE.sin_cos();
    (CENTRE + MID * c, CENTRE + MID * s)
}

/// One arc of the outline, in SVG terms (y down; `sweep` runs clockwise).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Arc {
    pub radius: f32,
    pub large: bool,
    pub sweep: bool,
    pub to: (f32, f32),
}

/// The ring's outline: a start point and four arcs back to it.
pub(crate) fn outline() -> ((f32, f32), [Arc; 4]) {
    let cut = POINT_R + GAP;
    // Half the angle, seen from the ring's centre, that the cut spans on a
    // circle of radius `r` (law of cosines).
    let half = |r: f32| ((r * r + MID * MID - cut * cut) / (2. * r * MID)).acos();
    let at = |r: f32, angle: f32| {
        let (s, c) = angle.sin_cos();
        (CENTRE + r * c, CENTRE + r * s)
    };
    let (outer, inner) = (half(OUTER), half(INNER));
    let start = at(OUTER, POINT_ANGLE + outer);
    (
        start,
        [
            // The outer edge clockwise, the long way, to the far side of the cut.
            Arc {
                radius: OUTER,
                large: true,
                sweep: true,
                to: at(OUTER, POINT_ANGLE - outer),
            },
            // Along the cut, inward.
            Arc {
                radius: cut,
                large: false,
                sweep: false,
                to: at(INNER, POINT_ANGLE - inner),
            },
            // The inner edge back, the long way.
            Arc {
                radius: INNER,
                large: true,
                sweep: false,
                to: at(INNER, POINT_ANGLE + inner),
            },
            // Along the cut, outward, to the start.
            Arc {
                radius: cut,
                large: false,
                sweep: false,
                to: start,
            },
        ],
    )
}

/// The ring's and the point's colours: an ink ring on light themes, paper on
/// dark; the point is always orange.
pub(crate) fn colors(light: bool) -> (Rgba, Rgba) {
    (rgb(if light { INK } else { PAPER }), rgb(ORANGE))
}

/// The Ring at `size` layout units, coloured for the running theme.
pub(crate) fn ring(size: f32) -> impl IntoElement {
    let (ring_color, point_color) = colors(crate::theme::light());
    canvas(
        |_, _, _| {},
        move |bounds: Bounds<Pixels>, _, window: &mut Window, _: &mut App| {
            let unit = size / 100.;
            let at = |(x, y): (f32, f32)| {
                point(bounds.left() + px(x * unit), bounds.top() + px(y * unit))
            };
            let (start, arcs) = outline();
            let mut path = PathBuilder::fill();
            path.move_to(at(start));
            for arc in arcs {
                let r = px(arc.radius * unit);
                path.arc_to(point(r, r), px(0.), arc.large, arc.sweep, at(arc.to));
            }
            path.close();
            if let Ok(path) = path.build() {
                window.paint_path(path, ring_color);
            }
            let (x, y) = point_centre();
            let r = px(POINT_R * unit);
            let mut dot = PathBuilder::fill();
            dot.move_to(at((x + POINT_R, y)));
            dot.arc_to(point(r, r), px(0.), false, true, at((x - POINT_R, y)));
            dot.arc_to(point(r, r), px(0.), false, true, at((x + POINT_R, y)));
            dot.close();
            if let Ok(dot) = dot.build() {
                window.paint_path(dot, point_color);
            }
        },
    )
    .size(px(size))
    .flex_shrink_0()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: (f32, f32), b: (f32, f32)) -> bool {
        (a.0 - b.0).abs() < 1e-2 && (a.1 - b.1).abs() < 1e-2
    }
    fn radius(p: (f32, f32)) -> f32 {
        (p.0 - CENTRE).hypot(p.1 - CENTRE)
    }

    #[test]
    fn geometry_matches_brand() {
        assert_eq!((OUTER, INNER, POINT_R, MID, GAP), (40., 22., 7.4, 31., 3.4));
        // ring-light.svg places the point and its mask at (71.92, 28.08).
        assert!(
            close(point_centre(), (71.92, 28.08)),
            "{:?}",
            point_centre()
        );
    }

    #[test]
    fn outline_runs_the_edges_and_the_cut() {
        let (start, arcs) = outline();
        // The cut meets the outer edge 9.73° and the inner edge 13.13° either
        // side of the point, as computed from the brand geometry.
        assert!(close(start, (82.656, 26.900)), "{start:?}");
        assert!(close(arcs[0].to, (73.100, 17.344)), "{:?}", arcs[0].to);
        assert!(close(arcs[1].to, (61.617, 31.317)), "{:?}", arcs[1].to);
        assert!(close(arcs[2].to, (68.683, 38.383)), "{:?}", arcs[2].to);
        assert_eq!(arcs[3].to, start);
        // Each corner lies on its edge and on the cut circle.
        let (cx, cy) = point_centre();
        for (p, edge) in [
            (start, OUTER),
            (arcs[0].to, OUTER),
            (arcs[1].to, INNER),
            (arcs[2].to, INNER),
        ] {
            assert!((radius(p) - edge).abs() < 1e-3);
            assert!(((p.0 - cx).hypot(p.1 - cy) - (POINT_R + GAP)).abs() < 1e-3);
        }
        // The edges go the long way round; the cut arcs are short.
        assert_eq!(
            arcs.map(|a| (a.radius, a.large, a.sweep)),
            [
                (40., true, true),
                (10.8, false, false),
                (22., true, false),
                (10.8, false, false)
            ]
        );
    }

    #[test]
    fn ink_on_light_paper_on_dark_point_always_orange() {
        assert_eq!(colors(true), (rgb(INK), rgb(ORANGE)));
        assert_eq!(colors(false), (rgb(PAPER), rgb(ORANGE)));
    }
}
