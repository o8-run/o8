//! Glance, o8's face, drawn natively every frame. The numbers are ported from
//! `brand/src/glance.py` (body, eyes, pupils, dot) and `brand/src/fog.py` (the
//! fog: stacked copies of the body at solved opacities, no blur), as recorded in
//! docs/design/BRAND.md §5. Motion comes from `brand/src/working.py`.
//!
//! The face is a handful of parameters ([`Face`]); a state is a target for
//! them, and a change of state eases from the pose on screen into the next.
use crate::motion::{bezier, ease_out, mix};
use gpui::{
    App, Bounds, IntoElement, PathBuilder, Pixels, Rgba, Styled, Window, canvas, point, px, rgb,
};

/// brand/tokens: ink, paper, orange, and the eye colour on a dark-mode body.
pub(crate) const INK: u32 = 0x17140F;
pub(crate) const PAPER: u32 = 0xF4F2EC;
pub(crate) const ORANGE: u32 = 0xFF5A1F;
/// tokens.json `graphite-eye`: Glance's eyes on a light (dark-mode) body.
pub(crate) const GRAPHITE_EYE: u32 = 0x1C1A17;

/// One cut of the face in its 100×100 box (glance.py `FULL` / `SMALL`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Cut {
    pub a: f32,
    pub b: f32,
    pub cx: f32,
    pub cy: f32,
    pub eyes: [(f32, f32); 2],
    pub erx: f32,
    pub ery: f32,
    pub pr: f32,
    pub pdx: f32,
    pub pdy: f32,
    pub dot: (f32, f32),
    pub dr: f32,
}

/// 48px and up.
pub(crate) const FULL: Cut = Cut {
    a: 42.,
    b: 36.,
    cx: 50.,
    cy: 53.,
    eyes: [(40., 50.), (63.5, 50.)],
    erx: 8.6,
    ery: 10.4,
    pr: 5.0,
    pdx: 3.5,
    pdy: 1.4,
    dot: (58.5, 72.),
    dr: 4.0,
};

/// Under 48px: a bigger face in the same box so it still reads.
pub(crate) const SMALL: Cut = Cut {
    a: 46.,
    b: 41.,
    cx: 50.,
    cy: 52.,
    eyes: [(37., 48.), (65., 48.)],
    erx: 11.5,
    ery: 13.5,
    pr: 7.4,
    pdx: 4.0,
    pdy: 1.6,
    dot: (58., 75.),
    dr: 6.0,
};

// glance.py body_path defaults shared by both cuts.
const N_TOP: f32 = 2.2;
const N_BOT: f32 = 2.6;
const EGG: f32 = 0.04;
const POINTS: usize = 72;

/// fog.py scales every layer, and working.py breathes the body, about (50,53)
/// in both cuts.
const FOG_CENTRE: (f32, f32) = (50., 53.);

/// A fog tier from fog.py `STYLES` (all use the smooth curve).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Fog {
    /// Dense inside this scale of the body...
    pub s0: f32,
    /// ...and gone by this one.
    pub s1: f32,
    pub peak: f32,
    pub n: usize,
    /// fog.py `VB` / `VBS`: the box's origin and side, in body units.
    pub view: (f32, f32),
}

pub(crate) const FOG: Fog = Fog {
    s0: 0.70,
    s1: 1.22,
    peak: 1.,
    n: 56,
    view: (-8., 116.),
};
pub(crate) const TIGHT: Fog = Fog {
    s0: 0.86,
    s1: 1.10,
    peak: 1.,
    n: 28,
    view: (-3., 106.),
};
pub(crate) const HAIR: Fog = Fog {
    s0: 0.93,
    s1: 1.07,
    peak: 1.,
    n: 20,
    view: (-3., 106.),
};

/// fog.py `TIER`: the fog and cut drawn at `size` px. Never below 16px.
pub(crate) fn tier(size: f32) -> (Fog, Cut) {
    if size >= 48. {
        (FOG, FULL)
    } else if size >= 24. {
        (TIGHT, SMALL)
    } else {
        (HAIR, SMALL)
    }
}

/// The body outline: glance.py's 72 superellipse points, flatter on top,
/// rounder below, narrowing a little toward the top.
pub(crate) fn body_points(cut: &Cut) -> Vec<(f32, f32)> {
    (0..POINTS)
        .map(|i| {
            let t = std::f32::consts::TAU * i as f32 / POINTS as f32;
            let (s, c) = t.sin_cos();
            let n = if s > 0. { N_BOT } else { N_TOP };
            let mut x = cut.a * c.abs().powf(2. / n).copysign(c);
            let y = cut.b * s.abs().powf(2. / n).copysign(s);
            if y < 0. {
                x *= 1. - EGG * (-y / cut.b);
            }
            (cut.cx + x, cut.cy + y)
        })
        .collect()
}

/// The closed Catmull-Rom curve through the body points as cubic segments,
/// (control 1, control 2, end), starting from the first point.
pub(crate) fn body_segments(points: &[(f32, f32)]) -> Vec<[(f32, f32); 3]> {
    let n = points.len();
    (0..n)
        .map(|i| {
            let p0 = points[(i + n - 1) % n];
            let p1 = points[i];
            let p2 = points[(i + 1) % n];
            let p3 = points[(i + 2) % n];
            [
                (p1.0 + (p2.0 - p0.0) / 6., p1.1 + (p2.1 - p0.1) / 6.),
                (p2.0 - (p3.0 - p1.0) / 6., p2.1 - (p3.1 - p1.1) / 6.),
                p2,
            ]
        })
        .collect()
}

/// fog.py's smooth density: full at u = 0, none at u = 1.
fn density(u: f32) -> f32 {
    let u = u.clamp(0., 1.);
    1. - u * u * (3. - 2. * u)
}

/// The fog's layers, outermost first, as (scale of the body, opacity). Each
/// layer's opacity is solved so the stacked coverage follows the density
/// curve; `strength` scales the peak (1 is the brand's fog).
pub(crate) fn fog_layers(fog: &Fog, strength: f32) -> Vec<(f32, f32)> {
    let peak = fog.peak * strength.clamp(0., 1.);
    let mut covered = 0f32;
    let mut layers = Vec::with_capacity(fog.n);
    for k in 0..fog.n {
        let s = fog.s1 - (fog.s1 - fog.s0) * (k as f32 / (fog.n - 1) as f32);
        let u = (s - fog.s0) / (fog.s1 - fog.s0);
        let target = peak * density(u);
        if target <= covered + 1e-4 {
            continue;
        }
        let alpha = if covered < 1. {
            1. - (1. - target) / (1. - covered)
        } else {
            0.
        };
        covered = target;
        layers.push((s, alpha));
    }
    layers
}

/// The face's animated parameters. Every state is a target for these.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Face {
    /// Pupil x offset in units of the cut's `pdx`: 1 looks right (rest).
    pub look: f32,
    /// Body scale about the fog centre: 1 at rest.
    pub breath: f32,
    /// Fog peak density, 0 to 1.
    pub fog: f32,
    /// Dot radius in units of the cut's `dr`.
    pub dot: f32,
    pub body: Rgba,
    pub eye: Rgba,
    pub pupil: Rgba,
    pub dot_color: Rgba,
}

impl Face {
    /// The reviewing pose and colours (BRAND.md §5): ink body, paper eyes
    /// looking right, orange dot; on dark themes a paper body with graphite eyes.
    pub(crate) fn resting(dark: bool) -> Self {
        let (body, eye, pupil) = if dark {
            (PAPER, GRAPHITE_EYE, PAPER)
        } else {
            (INK, PAPER, INK)
        };
        Self {
            look: 1.,
            breath: 1.,
            fog: 1.,
            dot: 1.,
            body: rgb(body),
            eye: rgb(eye),
            pupil: rgb(pupil),
            dot_color: rgb(ORANGE),
        }
    }

    /// `t` of the way from `self` to `to`.
    pub(crate) fn mix(&self, to: &Self, t: f32) -> Self {
        let t = t.clamp(0., 1.);
        let lerp = |a: f32, b: f32| a + (b - a) * t;
        Self {
            look: lerp(self.look, to.look),
            breath: lerp(self.breath, to.breath),
            fog: lerp(self.fog, to.fog),
            dot: lerp(self.dot, to.dot),
            body: mix(self.body, to.body, t),
            eye: mix(self.eye, to.eye, t),
            pupil: mix(self.pupil, to.pupil, t),
            dot_color: mix(self.dot_color, to.dot_color, t),
        }
    }
}

/// One loop of the Thinking motion (working.py `thinking`, `dur="4s"`).
pub(crate) const THINKING_LOOP: f32 = 4.;

/// SVG `calcMode="spline"` between (time, value) keys, each segment eased by
/// working.py's keySpline `0.65 0 0.35 1`.
fn keyed(t: f32, keys: &[(f32, f32)]) -> f32 {
    let t = t.rem_euclid(1.);
    keys.windows(2)
        .find(|w| t <= w[1].0)
        .map_or(keys[keys.len() - 1].1, |w| {
            let span = (w[1].0 - w[0].0).max(f32::EPSILON);
            let eased = bezier(0.65, 0., 0.35, 1., (t - w[0].0) / span);
            w[0].1 + (w[1].1 - w[0].1) * eased
        })
}

/// The Thinking pose `phase` (0..1) through its loop: the fog breathes to
/// 1.05, the pupils travel left across a line and back, the dot eases to 0.8.
pub(crate) fn thinking(rest: &Face, phase: f32) -> Face {
    Face {
        breath: keyed(phase, &[(0., 1.), (0.5, 1.05), (1., 1.)]),
        look: keyed(
            phase,
            &[
                (0., 1.),
                (0.18, 1.),
                (0.30, -0.7),
                (0.62, -0.7),
                (0.80, 1.),
                (1., 1.),
            ],
        ),
        dot: keyed(phase, &[(0., 1.), (0.5, 0.8), (1., 1.)]),
        ..*rest
    }
}

/// How long a change of state takes to settle into the next pose (BRAND.md §6).
pub(crate) const GLIDE_SECS: f32 = 0.2;

/// The pose `elapsed` seconds into a glide from `from` toward `to`.
pub(crate) fn glide(from: &Face, to: &Face, elapsed: f32) -> Face {
    from.mix(to, ease_out(elapsed / GLIDE_SECS))
}

/// What one frame draws, in the 100×100 box, back to front.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Shape {
    /// A copy of the body scaled about the fog centre.
    Body { scale: f32, color: Rgba },
    Ellipse {
        centre: (f32, f32),
        rx: f32,
        ry: f32,
        color: Rgba,
    },
}

/// The frame for `face` at `size` px: the fog layers, then the crisp eyes,
/// pupils and dot.
pub(crate) fn shapes(face: &Face, size: f32) -> Vec<Shape> {
    let (fog, cut) = tier(size);
    let mut out: Vec<Shape> = fog_layers(&fog, face.fog)
        .into_iter()
        .map(|(scale, alpha)| Shape::Body {
            scale: scale * face.breath,
            color: Rgba {
                a: face.body.a * alpha,
                ..face.body
            },
        })
        .collect();
    for (ex, ey) in cut.eyes {
        out.push(Shape::Ellipse {
            centre: (ex, ey),
            rx: cut.erx,
            ry: cut.ery,
            color: face.eye,
        });
        out.push(Shape::Ellipse {
            centre: (ex + face.look * cut.pdx, ey + cut.pdy),
            rx: cut.pr,
            ry: cut.pr,
            color: face.pupil,
        });
    }
    let r = cut.dr * face.dot;
    out.push(Shape::Ellipse {
        centre: cut.dot,
        rx: r,
        ry: r,
        color: face.dot_color,
    });
    out
}

/// Glance at `size` px, painted from `face` this frame.
pub(crate) fn glance(face: Face, size: f32) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds: Bounds<Pixels>, _, window: &mut Window, _: &mut App| {
            paint(bounds, &face, size, window)
        },
    )
    .size(px(size))
    .flex_shrink_0()
}

fn paint(bounds: Bounds<Pixels>, face: &Face, size: f32, window: &mut Window) {
    let (fog, cut) = tier(size);
    let (min, side) = fog.view;
    let unit = size / side;
    let at = |(x, y): (f32, f32)| {
        point(
            bounds.left() + px((x - min) * unit),
            bounds.top() + px((y - min) * unit),
        )
    };
    let points = body_points(&cut);
    let segments = body_segments(&points);
    for shape in shapes(face, size) {
        let mut path = PathBuilder::fill();
        match shape {
            Shape::Body { scale, color } => {
                let (cx, cy) = FOG_CENTRE;
                let place = |(x, y): (f32, f32)| at((cx + (x - cx) * scale, cy + (y - cy) * scale));
                path.move_to(place(points[0]));
                for [c1, c2, end] in &segments {
                    path.cubic_bezier_to(place(*end), place(*c1), place(*c2));
                }
                path.close();
                if let Ok(path) = path.build() {
                    window.paint_path(path, color);
                }
            }
            Shape::Ellipse {
                centre: (x, y),
                rx,
                ry,
                color,
            } => {
                let radii = point(px(rx * unit), px(ry * unit));
                path.move_to(at((x + rx, y)));
                path.arc_to(radii, px(0.), false, true, at((x - rx, y)));
                path.arc_to(radii, px(0.), false, true, at((x + rx, y)));
                path.close();
                if let Ok(path) = path.build() {
                    window.paint_path(path, color);
                }
            }
        }
    }
}

/// The system asks for reduced motion (macOS Accessibility › Display).
pub(crate) fn reduced_motion() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc::{class, msg_send, sel, sel_impl};
        // SAFETY: a class method on the shared workspace returning a BOOL.
        unsafe {
            let workspace: cocoa::base::id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let reduced: cocoa::base::BOOL =
                msg_send![workspace, accessibilityDisplayShouldReduceMotion];
            reduced != cocoa::base::NO
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn cuts_match_brand_geometry() {
        // BRAND.md §5 table, full cut.
        assert_eq!((FULL.a, FULL.b, FULL.cx, FULL.cy), (42., 36., 50., 53.));
        assert_eq!(FULL.eyes, [(40., 50.), (63.5, 50.)]);
        assert_eq!((FULL.erx, FULL.ery), (8.6, 10.4));
        assert_eq!((FULL.pr, FULL.pdx, FULL.pdy), (5.0, 3.5, 1.4));
        assert_eq!((FULL.dot, FULL.dr), ((58.5, 72.), 4.0));
        // Small cut.
        assert_eq!((SMALL.a, SMALL.b, SMALL.cx, SMALL.cy), (46., 41., 50., 52.));
        assert_eq!(SMALL.eyes, [(37., 48.), (65., 48.)]);
        assert_eq!((SMALL.erx, SMALL.ery), (11.5, 13.5));
        assert_eq!((SMALL.pr, SMALL.pdx, SMALL.pdy), (7.4, 4.0, 1.6));
        assert_eq!((SMALL.dot, SMALL.dr), ((58., 75.), 6.0));
    }

    #[test]
    fn tiers_follow_fog_py() {
        assert_eq!(tier(96.), (FOG, FULL));
        assert_eq!(tier(48.), (FOG, FULL));
        assert_eq!(tier(40.), (TIGHT, SMALL));
        assert_eq!(tier(24.), (TIGHT, SMALL));
        assert_eq!(tier(20.), (HAIR, SMALL));
    }

    #[test]
    fn body_points_match_glance_py() {
        let full = body_points(&FULL);
        assert_eq!(full.len(), 72);
        // Right, bottom, left and top extremes of the superellipse.
        assert!(close(full[0].0, 92.) && close(full[0].1, 53.));
        assert!(close(full[18].0, 50.) && close(full[18].1, 89.));
        assert!(close(full[36].0, 8.) && close(full[36].1, 53.));
        assert!(close(full[54].0, 50.) && close(full[54].1, 17.));
        // Values printed by glance.py for point 9 (45°, lower half, n 2.6) and
        // point 63 (315°, upper half, n 2.2, narrowed by the egg).
        assert!(
            close(full[9].0, 82.1713) && close(full[9].1, 80.5754),
            "{:?}",
            full[9]
        );
        let (x, y) = full[63];
        assert!(close(x, 79.7544) && close(y, 26.7294), "{x} {y}");
        let small = body_points(&SMALL);
        assert!(close(small[0].0, 96.) && close(small[18].1, 93.) && close(small[54].1, 11.));
    }

    #[test]
    fn body_curve_is_closed_catmull_rom() {
        let points = body_points(&FULL);
        let segments = body_segments(&points);
        assert_eq!(segments.len(), 72);
        assert_eq!(segments[71][2], points[0]);
        // First control point: p1 + (p2 - p0) / 6.
        let c1 = segments[0][0];
        assert!(close(c1.0, points[0].0 + (points[1].0 - points[71].0) / 6.));
        assert!(close(c1.1, points[0].1 + (points[1].1 - points[71].1) / 6.));
    }

    #[test]
    fn tight_fog_layers_match_fog_py() {
        // Values printed by fog.py's solver for "tight" (s0 .86, s1 1.10, n 28).
        let layers = fog_layers(&TIGHT, 1.);
        assert_eq!(layers.len(), 27);
        let expect_head = [(1.0911, 0.0040), (1.0822, 0.0117), (1.0733, 0.0189)];
        let expect_tail = [(0.8778, 0.5437), (0.8689, 0.7435), (0.86, 1.0)];
        for (got, want) in layers.iter().take(3).zip(expect_head) {
            assert!(
                close(got.0, want.0) && close(got.1, want.1),
                "{got:?} vs {want:?}"
            );
        }
        for (got, want) in layers.iter().rev().take(3).rev().zip(expect_tail) {
            assert!(
                close(got.0, want.0) && close(got.1, want.1),
                "{got:?} vs {want:?}"
            );
        }
        // The stacked coverage reaches full density inside s0.
        let covered = layers.iter().fold(0f32, |c, (_, a)| c + (1. - c) * a);
        assert!(close(covered, 1.));
    }

    #[test]
    fn full_fog_layers_match_fog_py() {
        let layers = fog_layers(&FOG, 1.);
        assert_eq!(layers.len(), 55);
        assert!(close(layers[0].0, 1.2105) && close(layers[0].1, 0.0010));
        let last = layers[54];
        assert!(close(last.0, 0.70) && close(last.1, 1.0));
    }

    #[test]
    fn thinking_ports_working_py_keyframes() {
        let rest = Face::resting(false);
        // Loop starts and ends on the resting pose.
        assert_eq!(thinking(&rest, 0.), rest);
        assert!(close(thinking(&rest, 1.).look, 1.));
        // Mid-loop: breathed to 1.05, dot at 0.8, pupils on the left (−0.7·pdx).
        let mid = thinking(&rest, 0.5);
        assert!(close(mid.breath, 1.05) && close(mid.dot, 0.8) && close(mid.look, -0.7));
        // Full-cut pupils at the left: 40 − 0.7·3.5 = 37.55 (thinking.svg values).
        assert!(close(40. + mid.look * FULL.pdx, 37.55));
        // Pupils hold right until 0.18 and are back by 0.80.
        assert!(close(thinking(&rest, 0.15).look, 1.));
        assert!(close(thinking(&rest, 0.9).look, 1.));
        // A spline segment eases: halfway through 0.18→0.30 is halfway in value.
        assert!(close(thinking(&rest, 0.24).look, 0.15));
    }

    #[test]
    fn dark_body_is_paper_with_graphite_eyes() {
        let dark = Face::resting(true);
        assert_eq!(dark.body, rgb(PAPER));
        assert_eq!(dark.eye, rgb(GRAPHITE_EYE));
        assert_eq!(dark.pupil, rgb(PAPER));
        assert_eq!(dark.dot_color, rgb(ORANGE));
        let light = Face::resting(false);
        assert_eq!(
            (light.body, light.eye, light.pupil),
            (rgb(INK), rgb(PAPER), rgb(INK))
        );
    }

    #[test]
    fn a_state_change_glides_from_the_pose_on_screen() {
        let rest = Face::resting(false);
        let away = Face { look: -0.7, ..rest };
        // The ease is solved by bisection, so its ends land within a hair.
        assert!(close(glide(&away, &rest, 0.).look, -0.7));
        assert!(close(glide(&away, &rest, GLIDE_SECS).look, 1.));
        assert!(close(glide(&away, &rest, 1.).look, 1.));
        let part = glide(&away, &rest, GLIDE_SECS / 3.);
        assert!(part.look > -0.7 && part.look < 1.);
    }

    /// The deterministic render check: the exact draw list for the 40px
    /// composer Glance, back to front.
    #[test]
    fn forty_px_frame_draws_tight_fog_then_the_face() {
        let rest = Face::resting(false);
        let frame = shapes(&rest, 40.);
        assert_eq!(frame.len(), 27 + 5);
        let Shape::Body { scale, color } = &frame[26] else {
            panic!("fog first")
        };
        assert!(close(*scale, 0.86) && close(color.a, 1.));
        assert_eq!(
            frame[27],
            Shape::Ellipse {
                centre: (37., 48.),
                rx: 11.5,
                ry: 13.5,
                color: rgb(PAPER)
            }
        );
        assert_eq!(
            frame[28],
            Shape::Ellipse {
                centre: (41., 49.6),
                rx: 7.4,
                ry: 7.4,
                color: rgb(INK)
            }
        );
        assert_eq!(
            frame[31],
            Shape::Ellipse {
                centre: (58., 75.),
                rx: 6.,
                ry: 6.,
                color: rgb(ORANGE)
            }
        );
        // Breathing scales every fog layer, never the crisp face.
        let breathed = shapes(&thinking(&rest, 0.5), 40.);
        let Shape::Body { scale, .. } = &breathed[26] else {
            panic!()
        };
        assert!(close(*scale, 0.86 * 1.05));
        assert_eq!(breathed[27], frame[27]);
    }
}
