//! The ink strokes as the web overlay draws them: a streamlined comet trail
//! that tapers from its tail into a round head, thinning with speed, under a
//! soft ember glow with a warm-white hot core, and a pulsing head while the
//! stroke is live. Each stroke is filled as one outline per chunk, so a frame
//! costs a few paths per stroke and no layout.
use super::*;
use gpui::{FillOptions, FillRule, PathBuilder, PathStyle, Pixels, Point};

/// The web overlay's widths (stroke.ts sizes): body, reduced motion, hot core.
pub(crate) const BODY: f32 = 6.;
pub(crate) const BODY_REDUCED: f32 = 3.;
pub(crate) const CORE: f32 = 2.2;
/// Points per filled outline; keeps each tessellation small.
const CHUNK: usize = 256;

/// Streamline the raw samples (perfect-freehand's 0.45) and drop repeats.
pub(crate) fn streamline(points: &[Mark]) -> Vec<(f32, f32)> {
    let mut out: Vec<(f32, f32)> = Vec::with_capacity(points.len());
    for mark in points {
        let next = match out.last() {
            Some(&(x, y)) => (x + (mark.x - x) * 0.55, y + (mark.y - y) * 0.55),
            None => (mark.x, mark.y),
        };
        if out
            .last()
            .is_none_or(|&(x, y)| (x - next.0).hypot(y - next.1) >= 0.25)
        {
            out.push(next);
        }
    }
    // The live head follows the pointer exactly.
    if let (Some(last), Some(mark)) = (out.last_mut(), points.last())
        && points.len() > 1
    {
        *last = (mark.x, mark.y);
    }
    out
}

/// Radius at each point: the tail tapers into the head (eased over the whole
/// stroke) and fast segments thin by up to 40%.
pub(crate) fn radii(points: &[(f32, f32)], size: f32) -> Vec<f32> {
    let lengths: Vec<f32> = std::iter::once(0.)
        .chain(
            points
                .windows(2)
                .map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1)),
        )
        .collect();
    let total: f32 = lengths.iter().sum::<f32>().max(f32::EPSILON);
    let mut walked = 0.;
    let mut pressure = 1.;
    lengths
        .iter()
        .map(|&segment| {
            walked += segment;
            let target = 1. - 0.4 * (segment / (size * 2.)).min(1.);
            pressure += (target - pressure) * 0.3;
            let t = (walked / total).min(1.);
            let taper = t * (2. - t);
            (size / 2. * pressure * taper).max(0.3)
        })
        .collect()
}

/// The closed outline of points `range` of a stroke, with round ends.
pub(crate) fn outline(points: &[(f32, f32)], radii: &[f32]) -> Vec<(f32, f32)> {
    let n = points.len();
    if n < 2 {
        return Vec::new();
    }
    let normal = |i: usize| {
        let (a, b) = (points[i.saturating_sub(1)], points[(i + 1).min(n - 1)]);
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let length = dx.hypot(dy).max(f32::EPSILON);
        (-dy / length, dx / length)
    };
    let mut left = Vec::with_capacity(n * 2 + 16);
    let mut right = Vec::with_capacity(n);
    for i in 0..n {
        let (nx, ny) = normal(i);
        let (x, y, r) = (points[i].0, points[i].1, radii[i]);
        left.push((x + nx * r, y + ny * r));
        right.push((x - nx * r, y - ny * r));
    }
    let cap = |center: (f32, f32), (nx, ny): (f32, f32), r: f32, out: &mut Vec<(f32, f32)>| {
        let start = ny.atan2(nx);
        for step in 1..8 {
            let angle = start - std::f32::consts::PI * step as f32 / 8.;
            out.push((center.0 + r * angle.cos(), center.1 + r * angle.sin()));
        }
    };
    // Head cap from the left side round the front to the right side.
    cap(points[n - 1], normal(n - 1), radii[n - 1], &mut left);
    left.extend(right.into_iter().rev());
    // Tail cap from the right side round the back to the left side.
    let (nx, ny) = normal(0);
    cap(points[0], (-nx, -ny), radii[0], &mut left);
    left
}

/// Everything one frame paints, computed in render; the canvas only fills it.
pub(crate) struct Scene {
    /// (outline, color) in draw order.
    fills: Vec<(Vec<(f32, f32)>, gpui::Rgba)>,
    /// (center, radius, color) dots: taps and the live head.
    dots: Vec<((f32, f32), f32, gpui::Rgba)>,
}

impl Scene {
    /// `head_ms` is set while a stroke is being drawn (its head pulses).
    pub(crate) fn new(
        strokes: &[Vec<Mark>],
        reduced: bool,
        alpha: f32,
        glow: f32,
        head_ms: Option<u64>,
    ) -> Self {
        let mut scene = Self {
            fills: Vec::new(),
            dots: Vec::new(),
        };
        let body = if reduced { BODY_REDUCED } else { BODY };
        for stroke in strokes {
            let points = streamline(stroke);
            if points.len() < 2 {
                if let Some(&point) = points.first() {
                    if !reduced {
                        scene.dots.push((point, 2.6 + 3. * glow, crate::theme::ink_ember(alpha * 0.2)));
                    }
                    scene.dots.push((point, 2.6, crate::theme::ink_ember(alpha)));
                }
                continue;
            }
            let mut passes = Vec::new();
            if !reduced {
                // The web glow is an 11 px shadow blur; two soft halos stand in.
                passes.push((body + 10. * glow, crate::theme::ink_ember(alpha * 0.1)));
                passes.push((body + 4. * glow, crate::theme::ink_ember(alpha * 0.22)));
            }
            passes.push((body, crate::theme::ink_ember(alpha)));
            if !reduced {
                passes.push((CORE, crate::theme::ink_core(alpha)));
            }
            for (size, color) in passes {
                let radii = radii(&points, size);
                let mut start = 0;
                while start + 1 < points.len() {
                    let end = (start + CHUNK).min(points.len() - 1);
                    scene
                        .fills
                        .push((outline(&points[start..=end], &radii[start..=end]), color));
                    start = end;
                }
            }
        }
        if let (Some(ms), Some(head)) = (head_ms, strokes.last().and_then(|s| s.last())) {
            let pulse = 4. + ((ms % 100_000) as f32 / 130.).sin() * 1.6;
            let r = pulse + 6.;
            let at = (head.x, head.y);
            scene.dots.push((at, r, crate::theme::ink_ember(alpha * 0.25)));
            scene.dots.push((at, r * 0.55, crate::theme::ink_ember(alpha * 0.7)));
            scene.dots.push((at, r * 0.3, crate::theme::ink_core(alpha * 0.95)));
        }
        scene
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.fills.is_empty() && self.dots.is_empty()
    }

    pub(crate) fn paint(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        let at = |(x, y): (f32, f32)| -> Point<Pixels> { bounds.origin + point(px(x), px(y)) };
        for (outline, color) in &self.fills {
            let Some((&first, rest)) = outline.split_first() else {
                continue;
            };
            let mut path = PathBuilder::fill().with_style(PathStyle::Fill(
                FillOptions::default().with_fill_rule(FillRule::NonZero),
            ));
            path.move_to(at(first));
            for &point in rest {
                path.line_to(at(point));
            }
            path.close();
            if let Ok(path) = path.build() {
                window.paint_path(path, *color);
            }
        }
        for &(center, r, color) in &self.dots {
            let origin = at((center.0 - r, center.1 - r));
            window.paint_quad(
                gpui::fill(Bounds::new(origin, size(px(r * 2.), px(r * 2.))), color)
                    .corner_radii(px(r)),
            );
        }
    }
}
