//! Snooze in the Inbox view: a row's right-click offers a few presets; the
//! thread leaves Active for a Snoozed shelf and, when its time comes, returns
//! to the top of Active with a Back badge until it is opened.
//!
//! The snoozes live in this window's shell state, not on the server, until
//! the server's inbox snooze state lands (docs/internals/inbox-settlement.md).
//! Modelled on T3 Code's Snooze presets (https://github.com/pingdotgg/t3code,
//! apps/web/src/components/Sidebar.snooze.ts); reimplemented, no code shared.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, MouseButton, div, px};

/// Lucide clock.
const CLOCK: &str = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2";
const HOUR: u64 = 3_600;
const DAY: u64 = 86_400;

/// The local time zone's offset from UTC at `at`, in seconds.
#[cfg(unix)]
fn offset(at: u64) -> i64 {
    let time = at as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the call; localtime_r is reentrant.
    if unsafe { libc::localtime_r(&time, &mut tm) }.is_null() {
        return 0;
    }
    tm.tm_gmtoff as i64
}
#[cfg(not(unix))]
fn offset(_: u64) -> i64 {
    0
}
/// Seconds since local midnight, and that midnight as a Unix second.
fn local_day(at: u64) -> (u64, u64) {
    let local = at as i64 + offset(at);
    let into = local.rem_euclid(DAY as i64) as u64;
    (into, at - into)
}
/// The Unix second of `hour`:00 local time, `days` after today.
fn at_hour(now: u64, days: u64, hour: u64) -> u64 {
    let (_, midnight) = local_day(now);
    let guess = midnight + days * DAY + hour * HOUR;
    // Correct for a daylight-saving change between now and then.
    (guess as i64 + offset(now) - offset(guess)) as u64
}
/// The presets offered at `now`: an hour, tonight while it is still ahead,
/// and tomorrow morning.
pub(super) fn presets(now: u64) -> Vec<(&'static str, u64)> {
    let mut presets = vec![("1 hour", now + HOUR)];
    let tonight = at_hour(now, 0, 20);
    if tonight > now + HOUR {
        presets.push(("Tonight · 8 PM", tonight));
    }
    presets.push(("Tomorrow morning · 9 AM", at_hour(now, 1, 9)));
    presets
}
/// "8 PM", or "Tue 9 AM" on another day; minutes show when not on the hour.
pub(super) fn until_label(until: u64, now: u64) -> String {
    let (into, midnight) = local_day(until);
    let (hour, minute) = (into / HOUR, into % HOUR / 60);
    let clock = match (hour % 12, minute) {
        (0, 0) => format!("12 {}", if hour < 12 { "AM" } else { "PM" }),
        (h, 0) => format!("{h} {}", if hour < 12 { "AM" } else { "PM" }),
        (0, m) => format!("12:{m:02} {}", if hour < 12 { "AM" } else { "PM" }),
        (h, m) => format!("{h}:{m:02} {}", if hour < 12 { "AM" } else { "PM" }),
    };
    if midnight == local_day(now).1 {
        return clock;
    }
    // 1970-01-01 was a Thursday.
    let day = ((midnight as i64 + offset(until)) / DAY as i64 + 4).rem_euclid(7) as usize;
    let name = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day];
    format!("{name} {clock}")
}

impl ThreadList {
    /// Restores the snoozes saved in the shell state.
    pub fn restore_snoozes(&mut self, snoozes: &std::collections::BTreeMap<String, u64>) {
        self.snoozes = snoozes.iter().map(|(id, at)| (id.clone(), *at)).collect();
        self.rebuild();
    }
    /// Snooze applies where Settle does, to a thread not yet settled.
    pub(super) fn snoozable(&self, id: &str) -> bool {
        self.settleable(id).is_some_and(|s| !s.settled())
    }
    /// Snoozed and not yet due.
    pub(super) fn snoozed(&self, id: &str) -> bool {
        self.snoozes
            .get(id)
            .is_some_and(|until| *until > recents::now())
    }
    /// A snooze shown as waiting whose time has now come.
    pub(super) fn snooze_due(&self) -> bool {
        let now = recents::now();
        let mut shelf = false;
        self.rows.iter().any(|row| {
            if row.kind == "section" {
                shelf = row.title == "Snoozed";
            }
            shelf
                && row
                    .id
                    .as_ref()
                    .and_then(|id| self.snoozes.get(id))
                    .is_some_and(|until| *until <= now)
        })
    }
    fn save_snoozes(&self, cx: &mut Context<Self>) {
        let mut snoozes: Vec<_> = self.snoozes.iter().map(|(k, v)| (k.clone(), *v)).collect();
        snoozes.sort();
        cx.emit(Event::Snoozes(snoozes));
    }
    /// Opening a thread whose snooze ended takes its Back badge away.
    pub(super) fn clear_woken(&mut self, id: &str, cx: &mut Context<Self>) {
        if self
            .snoozes
            .get(id)
            .is_some_and(|until| *until <= recents::now())
        {
            self.snoozes.remove(id);
            self.save_snoozes(cx);
        }
    }
    pub(super) fn snooze(&mut self, id: String, until: Option<u64>, cx: &mut Context<Self>) {
        self.row_menu = None;
        let index = self.rows.iter().position(|r| r.id.as_ref() == Some(&id));
        match until {
            Some(until) => self.snoozes.insert(id.clone(), until),
            None => self.snoozes.remove(&id),
        };
        self.save_snoozes(cx);
        self.rebuild();
        // As with Settle, the current thread hands the selection on.
        if until.is_some()
            && self.selected.as_ref() == Some(&id)
            && let Some(next) = self.next_active(index)
            && next != id
        {
            self.choose(next, cx);
        }
        cx.notify();
    }
    /// The row menu's Snooze presets, or Unsnooze for a snoozed thread.
    pub(super) fn snooze_items(&self, id: &str, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if !self.snoozable(id) {
            return vec![];
        }
        let now = recents::now();
        let items: Vec<(String, Option<u64>)> = if self.snoozed(id) {
            vec![("Unsnooze".into(), None)]
        } else {
            presets(now)
                .into_iter()
                .map(|(name, until)| (format!("Snooze {name}"), Some(until)))
                .collect()
        };
        items
            .into_iter()
            .enumerate()
            .map(|(i, (text, until))| {
                let id = id.to_owned();
                div()
                    .id(gpui::ElementId::Name(format!("snooze:{i}").into()))
                    .debug_selector(move || format!("sidebar-row-snooze-{i}"))
                    .h(px(28.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(7.))
                    .text_size(px(12.5))
                    .cursor_pointer()
                    .hover(|s| s.bg(theme().hover))
                    .child(crate::icon::stroke(CLOCK, theme().text_muted, 14., 1.7))
                    .child(text)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.snooze(id.clone(), until, cx)
                    }))
                    .into_any_element()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presets_are_ahead_and_ordered() {
        let now = 1_793_000_000;
        let presets = presets(now);
        assert_eq!(presets[0], ("1 hour", now + HOUR));
        assert!(presets.windows(2).all(|w| w[0].1 < w[1].1));
        let (into, _) = local_day(presets.last().unwrap().1);
        assert_eq!(into, 9 * HOUR);
    }
    #[test]
    fn labels_read_local_clock_times() {
        let now = 1_793_000_000;
        assert!(!until_label(now + HOUR, now).is_empty());
        let tomorrow = at_hour(now, 1, 9);
        assert!(until_label(tomorrow, now).ends_with(" 9 AM"));
    }
}
