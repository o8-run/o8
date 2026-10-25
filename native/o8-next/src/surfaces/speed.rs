use super::*;
use crate::theme::current as theme;
use std::{cell::RefCell, collections::VecDeque, time::Instant};

pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    sample: Rc<RefCell<Sample>>,
}
#[derive(Default)]
struct Sample {
    enabled: bool,
    generation: u64,
    pending: Option<(
        Instant,
        Option<FocusHandle>,
        Entity<crate::composer::Composer>,
        u64,
    )>,
    key_ms: VecDeque<f64>,
    frame_ms: VecDeque<f64>,
    last_input: Option<Instant>,
    interval: Option<Instant>,
    idle_ticks: u64,
    idle_seconds: f64,
    wakeups: Option<f64>,
    memory_mib: Option<f64>,
    memory_pending: bool,
    memory_at: Option<Instant>,
}
fn retain(values: &mut VecDeque<f64>, value: f64) {
    if values.len() == 64 {
        values.pop_front();
    }
    values.push_back(value);
}
fn metric(value: Option<f64>, unit: &str) -> String {
    value
        .map(|v| format!("{v:.2} {unit}"))
        .unwrap_or_else(|| "—".into())
}
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((90, || Command::Speed)),
    overlay_command: true,
    nav: |s, position, cx| {
        if position != NavPosition::AfterWorkspaces {
            return vec![];
        }
        let sample = s.surfaces.speed.sample.borrow();
        let values = [
            ("speed-key", metric(sample.key_ms.back().copied(), "ms")),
            ("speed-frame", metric(sample.frame_ms.back().copied(), "ms")),
            ("speed-wakeups", metric(sample.wakeups, "/s")),
            ("speed-memory", metric(sample.memory_mib, "MiB")),
        ];
        vec![
            div()
                .relative()
                .child(
                    div()
                        .id("speed-toggle")
                        .debug_selector(|| "speed-toggle".into())
                        .p(px(6.))
                        .cursor_pointer()
                        .child("Experimental speed")
                        .on_mouse_down(
                            gpui::MouseButton::Left,
                            cx.listener(|_, _, window, _| window.prevent_default()),
                        )
                        .on_click(cx.listener(|s, _, window, cx| s.toggle_speed(window, cx))),
                )
                .when(sample.enabled, |v| {
                    v.child(
                        gpui::deferred(
                            div()
                                .id("speed-panel")
                                .debug_selector(|| "speed-panel".into())
                                .absolute()
                                .top(px(34.))
                                .right(px(0.))
                                .w(px(176.))
                                .flex()
                                .flex_wrap()
                                .p(px(8.))
                                .rounded(px(7.))
                                .bg(theme().surface_raised)
                                .text_color(theme().text)
                                .text_size(px(11.))
                                .font_weight(gpui::FontWeight::LIGHT)
                                .children(values.into_iter().map(|(id, value)| {
                                    div()
                                        .debug_selector(move || id.into())
                                        .w(px(80.))
                                        .text_right()
                                        .h(px(20.))
                                        .child(value)
                                })),
                        )
                        .with_priority(1),
                    )
                })
                .into_any_element(),
        ]
    },
    key_down: |s, event, window, cx| {
        let mut sample = s.surfaces.speed.sample.borrow_mut();
        if sample.enabled {
            let now = Instant::now();
            sample.last_input = Some(now);
            // Capture ordinary keys without consuming input, shortcuts or focus.
            let modifiers = event.keystroke.modifiers;
            let input = s
                .active()
                .and_then(|tab| s.content.get(&s.key(&tab)))
                .and_then(|content| {
                    if let Content::Session(view) = content {
                        let input = view.read(cx).shell_composer();
                        input.read(cx).focus.is_focused(window).then_some(input)
                    } else {
                        None
                    }
                });
            if !modifiers.control
                && !modifiers.platform
                && !modifiers.alt
                && event.keystroke.key_char.is_some()
            {
                if let Some(input) = input {
                    let revision = input.read(cx).revision;
                    sample
                        .pending
                        .get_or_insert((now, window.focused(cx), input, revision));
                    cx.notify();
                }
            } else {
                sample.pending = None;
            }
        }
        false
    },
    frame_probe: |s| {
        let sample = s.surfaces.speed.sample.clone();
        let state = sample.borrow();
        if !state.enabled {
            return None;
        }
        let generation = state.generation;
        drop(state);
        let start = Instant::now();
        let measured = Cell::new(false);
        Some(
            canvas(
                |_, _, _| (),
                move |_, _, window, cx| {
                    if measured.replace(true) {
                        return;
                    }
                    let mut sample = sample.borrow_mut();
                    if !sample.enabled || sample.generation != generation {
                        return;
                    }
                    retain(&mut sample.frame_ms, start.elapsed().as_secs_f64() * 1000.);
                    if let Some((start, focus, input, revision)) = sample.pending.take() {
                        let input = input.read(cx);
                        if focus == window.focused(cx)
                            && input.revision > revision
                            && input.painted == input.revision
                        {
                            retain(&mut sample.key_ms, start.elapsed().as_secs_f64() * 1000.);
                        }
                    }
                },
            )
            .size(px(1.))
            .into_any_element(),
        )
    },
    tick: |s, cx| {
        let mut sample = s.surfaces.speed.sample.borrow_mut();
        if !sample.enabled {
            return;
        }
        let now = Instant::now();
        let interval = sample
            .interval
            .replace(now)
            .map(|t| now.duration_since(t).as_secs_f64())
            .unwrap_or(0.);
        // These are the existing shell reconciliation wakeups while input-idle.
        // Measuring them adds no timer and does not claim OS-wide interrupts.
        if sample
            .last_input
            .is_some_and(|t| now.duration_since(t) >= Duration::from_secs(1))
        {
            sample.idle_ticks += 1;
            sample.idle_seconds += interval;
            if sample.idle_seconds >= 1. {
                sample.wakeups = Some(sample.idle_ticks as f64 / sample.idle_seconds);
                sample.idle_ticks = 0;
                sample.idle_seconds = 0.;
                cx.notify();
            }
        }
        if sample.memory_pending
            || sample
                .memory_at
                .is_some_and(|t| now.duration_since(t) < Duration::from_secs(1))
        {
            return;
        }
        sample.memory_pending = true;
        sample.memory_at = Some(now);
        let generation = sample.generation;
        drop(sample);
        let task = cx.background_executor().spawn(async { process::usage() });
        cx.spawn(async move |s, cx| {
            let memory = task.await;
            let _ = s.update(cx, |s, cx| {
                let mut sample = s.surfaces.speed.sample.borrow_mut();
                if sample.enabled && sample.generation == generation {
                    sample.memory_pending = false;
                    sample.memory_mib = memory
                        .filter(|usage| usage.cpu_seconds.is_finite())
                        .map(|usage| usage.memory_mib);
                    cx.notify();
                }
            });
        })
        .detach();
    },
    ..Registration::new("", "Experimental speed", |s, _, window, cx| {
        s.toggle_speed(window, cx);
        None
    })
};
impl Shell {
    fn toggle_speed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut sample = self.surfaces.speed.sample.borrow_mut();
        *sample = Sample {
            enabled: !sample.enabled,
            generation: sample.generation + 1,
            last_input: Some(Instant::now()),
            ..Default::default()
        };
        drop(sample);
        self.palette = false;
        self.restore_focus(window, cx);
        cx.notify();
    }
}

#[cfg(test)]
#[path = "speed/tests.rs"]
mod tests;

#[path = "speed/process.rs"]
mod process;
