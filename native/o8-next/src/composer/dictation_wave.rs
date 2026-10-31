//! The dictation wave beside the mic (Q 2026-10-31, after the Claude desktop
//! composer). While dictation listens, dots drift right to left; each rises
//! with the microphone level the voice host relays for that moment. Without
//! levels the dots stay flat, so the wave never invents a voice.
use super::*;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const SLOTS: usize = 26;
const PITCH: f32 = 5.;
/// One sample per step; the drift between samples is interpolated.
const STEP: Duration = Duration::from_millis(60);
/// A level older than this reads as silence.
const STALE: Duration = Duration::from_millis(400);
pub(super) const WIDTH: f32 = SLOTS as f32 * PITCH;

#[derive(Default)]
pub(crate) struct Wave {
    levels: VecDeque<f32>,
    level: f32,
    heard: Option<Instant>,
    sampled: Option<Instant>,
}

impl Wave {
    pub(crate) fn hear(&mut self, level: f32) {
        self.level = level.clamp(0., 1.);
        self.heard = Some(Instant::now());
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }

    /// Samples up to now; returns how far the dots have drifted toward the
    /// next sample, 0 to 1.
    fn advance(&mut self) -> f32 {
        let now = Instant::now();
        let sampled = *self.sampled.get_or_insert(now);
        let steps = ((now - sampled).as_millis() / STEP.as_millis()) as usize;
        if steps > 0 {
            let level = if self.heard.is_some_and(|at| now - at < STALE) {
                self.level
            } else {
                0.
            };
            for _ in 0..steps.min(SLOTS) {
                self.levels.push_back(level);
            }
            while self.levels.len() > SLOTS {
                self.levels.pop_front();
            }
            self.sampled = Some(if steps > SLOTS {
                now
            } else {
                sampled + STEP * steps as u32
            });
        }
        let since = now - self.sampled.unwrap_or(now);
        (since.as_secs_f32() / STEP.as_secs_f32()).min(1.)
    }
}

impl Surface {
    /// The voice host's microphone level for the running dictation.
    pub(crate) fn dictation_level(&mut self, level: f32) {
        self.wave.borrow_mut().hear(level);
    }

    pub(super) fn dictation_wave(&self) -> impl IntoElement {
        let listening = self.dictation == super::DictationState::Listening;
        let wave = self.wave.clone();
        let color = theme().text_muted;
        div()
            .h(px(28.))
            .px(px(6.))
            .flex()
            .items_center()
            // Covers the model chip the wave slides over.
            .bg(theme().surface_raised)
            .opacity(if listening { 1. } else { 0.45 })
            .child(
                canvas(
                    // Redraw every frame while listening, as trace.rs does.
                    move |_, window, _| {
                        if listening {
                            window.request_animation_frame();
                        }
                    },
                    move |bounds, _, window, _| {
                        let mut wave = wave.borrow_mut();
                        let drift = if listening { wave.advance() } else { 0. };
                        let middle = bounds.origin.y + bounds.size.height / 2.;
                        let empty = SLOTS - wave.levels.len();
                        for slot in 0..SLOTS {
                            let level = slot.checked_sub(empty).map_or(0., |i| wave.levels[i]);
                            let x = (slot as f32 - drift) * PITCH + PITCH / 2. - 1.;
                            // The oldest dots fade out at the left edge.
                            let fade = ((x + 1.) / (PITCH * 3.)).clamp(0., 1.);
                            let height = 2. + level * 16.;
                            let mut dot = color;
                            dot.a *= fade;
                            window.paint_quad(
                                gpui::fill(
                                    Bounds::new(
                                        point(bounds.origin.x + px(x), middle - px(height / 2.)),
                                        size(px(2.), px(height)),
                                    ),
                                    dot,
                                )
                                .corner_radii(px(1.)),
                            );
                        }
                    },
                )
                .w(px(WIDTH))
                .h(px(20.)),
            )
    }
}
