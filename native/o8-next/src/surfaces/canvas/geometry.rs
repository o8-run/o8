//! Canvas coordinates are logical pixels; pan and pointer coordinates are viewport pixels.
//! Input subtracts the surface origin from a window point before applying the camera.
use serde::{Deserialize, Serialize};
pub const MIN_ZOOM: f32 = 0.01;
pub const MAX_ZOOM: f32 = 2.;
pub const MIN_W: f32 = 320.;
pub const MIN_H: f32 = 200.;
const WORLD: f32 = 5000.;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}
impl Rect {
    pub fn bounded(self) -> Self {
        Self {
            x: finite(self.x, 0.).clamp(-WORLD, WORLD),
            y: finite(self.y, 0.).clamp(-WORLD, WORLD),
            w: finite(self.w, MIN_W).clamp(MIN_W, 4000.),
            h: finite(self.h, MIN_H).clamp(MIN_H, 4000.),
        }
    }
    pub fn moved(self, delta: [f32; 2]) -> Self {
        Self {
            x: self.x + delta[0],
            y: self.y + delta[1],
            ..self
        }
        .bounded()
    }
    pub fn resized(self, delta: [f32; 2]) -> Self {
        Self {
            w: self.w + delta[0],
            h: self.h + delta[1],
            ..self
        }
        .bounded()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Camera {
    pub pan: [f32; 2],
    pub zoom: f32,
}
impl Default for Camera {
    fn default() -> Self {
        Self {
            pan: [0., 0.],
            zoom: 1.,
        }
    }
}
impl Camera {
    pub fn bounded(self) -> Self {
        Self {
            pan: self
                .pan
                .map(|p| finite(p, 0.).clamp(-1_000_000., 1_000_000.)),
            zoom: finite(self.zoom, 1.).clamp(MIN_ZOOM, MAX_ZOOM),
        }
    }
    pub fn to_canvas(self, point: [f32; 2]) -> [f32; 2] {
        [
            (point[0] - self.pan[0]) / self.zoom,
            (point[1] - self.pan[1]) / self.zoom,
        ]
    }
    pub fn to_window(self, point: [f32; 2]) -> [f32; 2] {
        [
            point[0] * self.zoom + self.pan[0],
            point[1] * self.zoom + self.pan[1],
        ]
    }
    pub fn zoom_at(&mut self, zoom: f32, pointer: [f32; 2]) {
        let anchor = self.to_canvas(pointer);
        self.zoom = finite(zoom, self.zoom).clamp(MIN_ZOOM, MAX_ZOOM);
        self.pan = [
            pointer[0] - anchor[0] * self.zoom,
            pointer[1] - anchor[1] * self.zoom,
        ];
    }
    pub fn fit(&mut self, cards: impl Iterator<Item = Rect>, viewport: [f32; 2]) {
        let mut cards = cards;
        let Some(first) = cards.next() else {
            *self = Self::default();
            return;
        };
        let mut lo = [first.x, first.y];
        let mut hi = [first.x + first.w, first.y + first.h];
        for r in cards {
            lo[0] = lo[0].min(r.x);
            lo[1] = lo[1].min(r.y);
            hi[0] = hi[0].max(r.x + r.w);
            hi[1] = hi[1].max(r.y + r.h);
        }
        self.zoom = ((viewport[0] - 48.).max(1.) / (hi[0] - lo[0]))
            .min((viewport[1] - 48.).max(1.) / (hi[1] - lo[1]))
            .clamp(MIN_ZOOM, MAX_ZOOM);
        self.pan = [
            viewport[0] / 2. - (lo[0] + hi[0]) / 2. * self.zoom,
            viewport[1] / 2. - (lo[1] + hi[1]) / 2. * self.zoom,
        ];
    }
}
fn finite(value: f32, fallback: f32) -> f32 {
    if value.is_finite() { value } else { fallback }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn near(a: [f32; 2], b: [f32; 2]) {
        for i in 0..2 {
            assert!((a[i] - b[i]).abs() < 0.02, "{a:?} != {b:?}");
        }
    }
    #[test]
    fn canvas_coordinate_transforms_and_pointer_zoom() {
        for zoom in [MIN_ZOOM, 0.25, 0.7, 1., MAX_ZOOM] {
            let mut c = Camera {
                pan: [-170., 83.],
                zoom,
            };
            near(c.to_canvas(c.to_window([412., -52.])), [412., -52.]);
            let pointer = [331., 204.];
            let anchor = c.to_canvas(pointer);
            c.zoom_at(zoom * 1.4, pointer);
            near(c.to_window(anchor), pointer);
        }
    }
    #[test]
    fn canvas_fit_recovers_distant_cards_and_empty_layout() {
        let cards = [
            Rect {
                x: -5000.,
                y: -5000.,
                w: 320.,
                h: 200.,
            },
            Rect {
                x: 5000.,
                y: 5000.,
                w: 4000.,
                h: 4000.,
            },
        ];
        let mut c = Camera::default();
        c.fit(cards.into_iter(), [800., 600.]);
        for r in cards {
            for p in [[r.x, r.y], [r.x + r.w, r.y + r.h]] {
                let p = c.to_window(p);
                assert!(p[0] >= 0. && p[0] <= 800. && p[1] >= 0. && p[1] <= 600.);
            }
        }
        c.fit(std::iter::empty(), [800., 600.]);
        assert_eq!(c, Camera::default());
    }
    #[test]
    fn canvas_geometry_rejects_nonfinite_and_enforces_size_limits() {
        let r = Rect {
            x: f32::INFINITY,
            y: f32::NAN,
            w: 0.,
            h: -4.,
        }
        .bounded();
        assert_eq!(
            r,
            Rect {
                x: 0.,
                y: 0.,
                w: MIN_W,
                h: MIN_H
            }
        );
        assert_eq!(r.resized([-100., -100.]), r);
        assert_eq!(
            Camera {
                zoom: f32::NAN,
                pan: [f32::INFINITY, 0.]
            }
            .bounded(),
            Camera::default()
        );
    }
}
