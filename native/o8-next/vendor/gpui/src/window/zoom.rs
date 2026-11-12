//! o8: per-window interface zoom (see O8-PATCHES.md).
//!
//! The window lays out in its platform content size divided by the zoom and
//! paints with the platform scale factor multiplied by it, so every length,
//! glyph and image grows or shrinks together at full sharpness. Window
//! coordinates (layout, `viewport_size`, `mouse_position`, element bounds)
//! are zoomed; platform coordinates are not. The conversions between them,
//! `from_platform` for incoming input and `to_platform` and
//! `point_to_platform` for outgoing text-input bounds, the window menu and the
//! client-side decoration inset, live here so call sites stay one line.
use crate::{
    App, Bounds, FileDropEvent, Pixels, PlatformInput, Point, ScrollDelta, Window,
};

impl Window {
    /// The interface zoom, 1.0 by default.
    pub fn zoom(&self) -> f32 {
        self.zoom
    }

    /// Zoom the whole window, as a browser zooms a page. Values that are not
    /// finite and positive are ignored.
    ///
    /// Callers are usually inside an entity's update (a key handler, a
    /// button), so bounds observers, which update their own entities, run
    /// after it, never during this call.
    pub fn set_zoom(&mut self, zoom: f32, cx: &mut App) {
        if !zoom.is_finite() || zoom <= 0. || zoom == self.zoom {
            return;
        }
        let ratio = self.zoom / zoom;
        self.zoom = zoom;
        self.mouse_position = self.mouse_position.map(|v| v * ratio);
        self.read_platform_metrics();
        if let Some(inset) = self.client_inset {
            self.platform_window.set_client_inset(inset * zoom);
        }
        self.invalidator.wake();
        self.refresh();
        self.defer(cx, |window, cx| {
            window
                .bounds_observers
                .clone()
                .retain(&(), |callback| callback(window, cx));
        });
    }

    /// The platform's scale factor and content size, at this zoom.
    pub(crate) fn read_platform_metrics(&mut self) {
        self.scale_factor = self.platform_window.scale_factor() * self.zoom;
        self.viewport_size = self.platform_window.content_size().map(|v| v / self.zoom);
    }

    /// Window bounds in platform coordinates.
    pub(crate) fn to_platform(&self, bounds: Bounds<Pixels>) -> Bounds<Pixels> {
        bounds.map(|v| v * self.zoom)
    }

    /// A window point in platform coordinates.
    pub(crate) fn point_to_platform(&self, point: Point<Pixels>) -> Point<Pixels> {
        point.map(|v| v * self.zoom)
    }

    /// A platform point in window coordinates.
    pub(crate) fn from_platform(&self, point: Point<Pixels>) -> Point<Pixels> {
        point.map(|v| v / self.zoom)
    }

    /// A platform input event in window coordinates.
    pub(crate) fn input_from_platform(&self, event: PlatformInput) -> PlatformInput {
        if self.zoom == 1. {
            return event;
        }
        let at = |position| self.from_platform(position);
        match event {
            PlatformInput::MouseMove(mut e) => {
                e.position = at(e.position);
                PlatformInput::MouseMove(e)
            }
            PlatformInput::MouseDown(mut e) => {
                e.position = at(e.position);
                PlatformInput::MouseDown(e)
            }
            PlatformInput::MouseUp(mut e) => {
                e.position = at(e.position);
                PlatformInput::MouseUp(e)
            }
            PlatformInput::MouseExited(mut e) => {
                e.position = at(e.position);
                PlatformInput::MouseExited(e)
            }
            PlatformInput::ScrollWheel(mut e) => {
                e.position = at(e.position);
                if let ScrollDelta::Pixels(delta) = e.delta {
                    e.delta = ScrollDelta::Pixels(at(delta));
                }
                PlatformInput::ScrollWheel(e)
            }
            PlatformInput::FileDrop(FileDropEvent::Entered { position, paths }) => {
                PlatformInput::FileDrop(FileDropEvent::Entered {
                    position: at(position),
                    paths,
                })
            }
            PlatformInput::FileDrop(FileDropEvent::Pending { position }) => {
                PlatformInput::FileDrop(FileDropEvent::Pending {
                    position: at(position),
                })
            }
            PlatformInput::FileDrop(FileDropEvent::Submit { position }) => {
                PlatformInput::FileDrop(FileDropEvent::Submit {
                    position: at(position),
                })
            }
            event => event,
        }
    }

    /// The bounds of every quad the last drawn frame painted, in device pixels.
    #[cfg(any(test, feature = "test-support"))]
    pub fn painted_quad_bounds(&self) -> Vec<Bounds<crate::ScaledPixels>> {
        self.rendered_frame
            .scene
            .quads
            .iter()
            .map(|quad| quad.bounds)
            .collect()
    }
}
