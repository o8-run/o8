//! Header pill motion, from WorkspaceHeaderStrip's Continuity V1: pills
//! spring in and out (opacity 0 and scale 0.85, stiffness 400, damping 30),
//! the pills that stay slide into place, and the selected fill crossfades
//! over 120ms. GPUI cannot scale an element, so a pill grows and shrinks in
//! width from its centre instead, which moves its neighbours the way
//! framer's layout animation does.
use crate::motion::Transition;
use gpui::{IntoElement, ParentElement, Styled, canvas, div, px};
use std::{cell::Cell, collections::HashMap, rc::Rc, time::Instant};

/// framer-motion's spring { stiffness: 400, damping: 30 } with mass 1, from
/// rest at 0 toward 1. Underdamped, so it overshoots by about 3%.
pub(super) fn spring(seconds: f32) -> f32 {
    const OMEGA: f32 = 20.;
    const ZETA: f32 = 0.75;
    if seconds >= SETTLE {
        return 1.;
    }
    let decay = ZETA * OMEGA;
    let damped = OMEGA * (1. - ZETA * ZETA).sqrt();
    let t = seconds.max(0.);
    1. - (-decay * t).exp() * ((damped * t).cos() + decay / damped * (damped * t).sin())
}

/// The spring is within 0.002 of rest here.
const SETTLE: f32 = 0.45;
/// The strip's gap between pills.
const GAP: f32 = 2.;

/// One pill as the header shows it this frame.
pub(super) struct Shown {
    pub key: String,
    pub label: String,
    pub glyph: &'static str,
    pub selected: bool,
}

struct Pill {
    /// When the pill appeared; None once it has settled.
    born: Option<Instant>,
    selected: Transition,
    label: String,
    glyph: &'static str,
    /// The pill's left edge in the window and its width, as last painted.
    x: Rc<Cell<f32>>,
    width: Rc<Cell<f32>>,
    /// How far the pill started from its new place after a reorder.
    slide: Option<(f32, Instant)>,
}

/// A closed pill on its way out, at its old place in the strip.
pub(super) struct Ghost {
    pub index: usize,
    pub label: String,
    pub glyph: &'static str,
    pub selected: bool,
    width: f32,
    died: Instant,
}

#[derive(Default)]
pub(super) struct Pills {
    /// The workspace the strip shows. A different workspace's pills arrive
    /// at rest, as framer's `initial={false}` does on mount.
    workspace: Option<String>,
    order: Vec<String>,
    pills: HashMap<String, Pill>,
    ghosts: Vec<Ghost>,
}

impl Pills {
    /// Follows the strip to `shown`, and reports whether anything still moves.
    pub(super) fn update(&mut self, workspace: &str, shown: &[Shown]) -> bool {
        let now = Instant::now();
        let mount = self.workspace.as_deref() != Some(workspace);
        if mount {
            self.workspace = Some(workspace.to_string());
            self.pills.clear();
            self.ghosts.clear();
            self.order.clear();
        }
        let keys = shown
            .iter()
            .map(|pill| pill.key.clone())
            .collect::<Vec<_>>();
        let added = keys.iter().any(|key| !self.pills.contains_key(key));
        let mut removed = false;
        for (index, key) in self.order.iter().enumerate() {
            if keys.contains(key) {
                continue;
            }
            removed = true;
            if let Some(pill) = self.pills.remove(key) {
                self.ghosts.push(Ghost {
                    index,
                    label: pill.label,
                    glyph: pill.glyph,
                    selected: pill.selected.is_open(),
                    width: pill.width.get(),
                    died: now,
                });
            }
        }
        if !added && !removed && keys != self.order {
            self.slide(&keys, now);
        }
        for pill in shown {
            let entry = self.pills.entry(pill.key.clone()).or_insert_with(|| Pill {
                born: (!mount).then_some(now),
                selected: Transition::settled(120, pill.selected),
                label: String::new(),
                glyph: pill.glyph,
                x: Rc::default(),
                width: Rc::default(),
                slide: None,
            });
            entry.selected.set(pill.selected);
            entry.label = pill.label.clone();
            entry.glyph = pill.glyph;
        }
        self.order = keys;
        let settled = |at: &Instant| at.elapsed().as_secs_f32() >= SETTLE;
        self.ghosts.retain(|ghost| !settled(&ghost.died));
        let mut moving = !self.ghosts.is_empty();
        for pill in self.pills.values_mut() {
            if pill.born.as_ref().is_some_and(settled) {
                pill.born = None;
            }
            if pill.slide.as_ref().is_some_and(|(_, at)| settled(at)) {
                pill.slide = None;
            }
            moving |= pill.born.is_some() || pill.slide.is_some() || pill.selected.value().1;
        }
        moving
    }

    /// A reorder: each pill starts where it was painted and slides to where
    /// the new order puts it, laid out from the measured widths.
    fn slide(&mut self, keys: &[String], now: Instant) {
        let Some(start) = keys
            .iter()
            .filter_map(|key| self.pills.get(key))
            .map(|pill| pill.x.get())
            .reduce(f32::min)
        else {
            return;
        };
        let mut x = start;
        for key in keys {
            let Some(pill) = self.pills.get_mut(key) else {
                return;
            };
            let from = pill.x.get() - x;
            if from.abs() > 0.5 {
                pill.slide = Some((from, now));
            }
            x += pill.width.get() + GAP;
        }
    }

    /// How far the pill's selected fill has crossfaded in.
    pub(super) fn selected(&self, key: &str, selected: bool) -> f32 {
        self.pills
            .get(key)
            .map_or(f32::from(u8::from(selected)), |pill| {
                pill.selected.value().0
            })
    }

    /// Measures the pill it is placed in, for the next reorder and entrance.
    pub(super) fn probe(&self, key: &str) -> Option<impl IntoElement + use<>> {
        let pill = self.pills.get(key)?;
        let (x, width) = (pill.x.clone(), pill.width.clone());
        Some(
            canvas(
                move |bounds, _, _| {
                    x.set(f32::from(bounds.origin.x));
                    width.set(f32::from(bounds.size.width));
                },
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        )
    }

    /// Wraps a pill in its entrance and slide.
    pub(super) fn wrap(&self, key: &str, pill: impl IntoElement) -> gpui::Div {
        let wrapper = div().flex_shrink_0().flex().justify_center();
        let Some(motion) = self.pills.get(key) else {
            return wrapper.child(pill);
        };
        let wrapper = match motion.slide {
            Some((from, at)) => wrapper
                .relative()
                .left(px(from * (1. - spring(at.elapsed().as_secs_f32())))),
            None => wrapper,
        };
        match motion.born {
            Some(at) => {
                let shown = spring(at.elapsed().as_secs_f32());
                grow(wrapper, motion.width.get(), shown).child(pill)
            }
            None => wrapper.child(pill),
        }
    }

    pub(super) fn ghosts(&self) -> impl Iterator<Item = (&Ghost, gpui::Div)> {
        self.ghosts.iter().map(|ghost| {
            let shown = 1. - spring(ghost.died.elapsed().as_secs_f32());
            let wrapper = div().flex_shrink_0().flex().justify_center();
            (ghost, grow(wrapper, ghost.width, shown))
        })
    }
}

/// `shown` of the pill's width, clipped about its centre, at `shown` opacity.
fn grow(wrapper: gpui::Div, width: f32, shown: f32) -> gpui::Div {
    let shown = shown.clamp(0., 1.);
    wrapper
        .w(px(width * shown))
        .overflow_hidden()
        .opacity(shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(keys: &[&str], selected: usize) -> Vec<Shown> {
        keys.iter()
            .enumerate()
            .map(|(index, key)| Shown {
                key: key.to_string(),
                label: key.to_string(),
                glyph: "",
                selected: index == selected,
            })
            .collect()
    }

    #[test]
    fn the_spring_starts_at_rest_overshoots_slightly_and_settles() {
        assert_eq!(spring(0.), 0.);
        let peak = (1..45)
            .map(|step| spring(step as f32 / 100.))
            .fold(0., f32::max);
        assert!(peak > 1. && peak < 1.04, "peak {peak}");
        assert!((spring(0.44) - 1.).abs() < 0.003);
        assert_eq!(spring(SETTLE), 1.);
    }

    #[test]
    fn a_workspace_mounts_at_rest_and_later_pills_enter() {
        let mut pills = Pills::default();
        assert!(!pills.update("w", &shown(&["a", "b"], 0)));
        assert!(pills.pills.values().all(|pill| pill.born.is_none()));
        assert!(pills.update("w", &shown(&["a", "b", "c"], 0)));
        assert!(pills.pills["c"].born.is_some());
        assert!(pills.pills["a"].born.is_none());
        // Another workspace's strip arrives at rest too.
        assert!(!pills.update("v", &shown(&["x"], 0)));
    }

    #[test]
    fn a_closed_pill_leaves_a_ghost_at_its_old_place() {
        let mut pills = Pills::default();
        pills.update("w", &shown(&["a", "b", "c"], 1));
        pills.pills["b"].width.set(80.);
        assert!(pills.update("w", &shown(&["a", "c"], 0)));
        let (ghost, _) = pills.ghosts().next().expect("ghost");
        assert_eq!((ghost.index, ghost.width, ghost.selected), (1, 80., true));
    }

    #[test]
    fn a_reorder_slides_each_pill_from_where_it_was_painted() {
        let mut pills = Pills::default();
        pills.update("w", &shown(&["a", "b"], 0));
        for (key, x, width) in [("a", 10., 60.), ("b", 72., 40.)] {
            pills.pills[key].x.set(x);
            pills.pills[key].width.set(width);
        }
        assert!(pills.update("w", &shown(&["b", "a"], 1)));
        // b now starts the strip at 10, a follows at 10 + 40 + 2.
        assert_eq!(pills.pills["b"].slide.map(|(from, _)| from), Some(62.));
        assert_eq!(pills.pills["a"].slide.map(|(from, _)| from), Some(-42.));
    }

    #[test]
    fn the_selected_fill_crossfades_instead_of_switching() {
        let mut pills = Pills::default();
        pills.update("w", &shown(&["a", "b"], 0));
        assert_eq!(pills.selected("a", true), 1.);
        assert!(pills.update("w", &shown(&["a", "b"], 1)));
        assert!(pills.selected("b", true) < 1.);
        assert!(pills.selected("a", false) > 0.);
    }
}
