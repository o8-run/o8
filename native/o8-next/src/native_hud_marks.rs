//! The HUD's Symon marks, drawn as SymonVisuals draws them on the web: the
//! 30-bar measured waveform with its 70 ms bar easing, and the polishing
//! squiggle with its travelling 2.1 s dash.
use super::*;
use gpui::{PathBuilder, Pixels, canvas};

/// SymonVisuals' SYMON_POLISH_PATH in its 416×52 view box: a start point and
/// six cubic segments (control a, control b, end).
const START: (f32, f32) = (8., 28.);
const CUBICS: [[(f32, f32); 3]; 6] = [
    [(32., 22.), (48., 14.), (72., 14.)],
    [(96., 14.), (108., 34.), (132., 34.)],
    [(156., 34.), (170., 12.), (198., 12.)],
    [(230., 12.), (238., 38.), (272., 38.)],
    [(304., 38.), (316., 18.), (344., 18.)],
    [(372., 18.), (388., 28.), (408., 28.)],
];
const STEPS: usize = 12;

/// The squiggle sampled into short pieces: (from, to, path position 0..100 at
/// the piece's middle, horizontal gradient position 0..1).
pub(crate) fn polish_pieces() -> Vec<((f32, f32), (f32, f32), f32, f32)> {
    let mut points = vec![START];
    let mut from = START;
    for [a, b, to] in CUBICS {
        for step in 1..=STEPS {
            let t = step as f32 / STEPS as f32;
            let u = 1. - t;
            let mix = |p0: f32, p1: f32, p2: f32, p3: f32| {
                u * u * u * p0 + 3. * u * u * t * p1 + 3. * u * t * t * p2 + t * t * t * p3
            };
            points.push((mix(from.0, a.0, b.0, to.0), mix(from.1, a.1, b.1, to.1)));
        }
        from = to;
    }
    let lengths: Vec<f32> = points
        .windows(2)
        .map(|w| ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt())
        .collect();
    let total: f32 = lengths.iter().sum();
    let mut walked = 0.;
    points
        .windows(2)
        .zip(lengths)
        .map(|(w, length)| {
            let middle = (walked + length / 2.) / total * 100.;
            walked += length;
            let across = ((w[0].0 + w[1].0) / 2. - START.0) / (CUBICS[5][2].0 - START.0);
            (w[0], w[1], middle, across)
        })
        .collect()
}

/// Where the 36-long dash starts along the 100-long path at `ms`: the web's
/// stroke-dashoffset 36 → -36 → 36 over 2.1 s with an ease-in-out spline.
pub(crate) fn dash_start(ms: u64) -> f32 {
    let cycle = (ms % 2100) as f32 / 2100.;
    let half = if cycle < 0.5 {
        cycle * 2.
    } else {
        2. - cycle * 2.
    };
    let eased = half * half * (3. - 2. * half);
    // Offset d runs 36 → -36; the dash then covers [-d, -d + 36].
    -(36. - 72. * eased)
}

/// Whether a path position falls inside the travelling dash.
pub(crate) fn in_dash(position: f32, start: f32) -> bool {
    (position - start).rem_euclid(100.) < 36.
}

/// The polishing squiggle at 96×18, as the web's `SymonPolishMark active`.
pub(crate) fn polish_mark(reduced_motion: bool) -> impl IntoElement {
    let start = (!reduced_motion).then(|| dash_start(capsules::now_ms()));
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            // The view box is fitted to 96×18: width-limited, centred vertically.
            let scale = 96. / 416.;
            let top = (18. - 52. * scale) / 2.;
            let at = |(x, y): (f32, f32)| bounds.origin + point(px(x * scale), px(top + y * scale));
            let width: Pixels = px(12. * scale);
            for (from, to, position, across) in polish_pieces() {
                let mut paint = |color: gpui::Rgba| {
                    let mut path = PathBuilder::stroke(width);
                    path.move_to(at(from));
                    path.line_to(at(to));
                    if let Ok(path) = path.build() {
                        window.paint_path(path, color);
                    }
                };
                match start {
                    Some(start) => {
                        paint(crate::theme::symon_track());
                        if in_dash(position, start) {
                            paint(crate::theme::symon_color(across));
                        }
                    }
                    None => paint(crate::theme::symon_color(across)),
                }
            }
        },
    )
    .w(px(96.))
    .h(px(18.))
    .flex_shrink_0()
}

/// The measured level easing toward each new frame over 70 ms, as the web
/// bars' transform transition; reduced motion jumps.
#[derive(Clone, Copy)]
pub(crate) struct LevelEase {
    from: f32,
    to: f32,
    at: Instant,
}
impl Default for LevelEase {
    fn default() -> Self {
        Self {
            from: 0.,
            to: 0.,
            at: Instant::now(),
        }
    }
}
impl LevelEase {
    const MS: f32 = 70.;
    pub(crate) fn set(&mut self, level: f32) {
        let level = if level.is_finite() {
            level.clamp(0., 1.)
        } else {
            0.
        };
        if level != self.to {
            self.from = self.value(false).0;
            self.to = level;
            self.at = Instant::now();
        }
    }
    /// The level to draw and whether it is still moving.
    pub(crate) fn value(&self, reduced_motion: bool) -> (f32, bool) {
        let t = self.at.elapsed().as_secs_f32() * 1000. / Self::MS;
        if reduced_motion || t >= 1. {
            return (self.to, false);
        }
        let eased = crate::motion::ease_out(t);
        (self.from + (self.to - self.from) * eased, true)
    }
}

/// SymonVisuals' 30-bar waveform at 90 px, measured level times the live gain.
pub(crate) fn waveform(level: f32) -> gpui::Div {
    let scale = 90. / 132.5;
    let amplitude = (level.max(0.) * 1.4).min(1.);
    let mut bars = div()
        .flex()
        .items_center()
        .gap(px(2.5 * scale))
        .h(px(24. * scale));
    for i in 0..30 {
        let distance = (i as f32 - 14.5).abs() / 14.5;
        let weight = (-1.8 * distance * distance).exp();
        bars = bars.child(
            div()
                .w(px(2. * scale))
                .h(px((amplitude * weight * 24.).max(2.) * scale))
                .rounded(px(1.))
                .bg(crate::theme::symon_color(i as f32 / 29.)),
        );
    }
    bars
}
