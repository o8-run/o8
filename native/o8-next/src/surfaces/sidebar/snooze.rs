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
/// The Unix second `secs` into the local day `days` after today.
fn at_local(now: u64, days: u64, secs: u64) -> u64 {
    let (_, midnight) = local_day(now);
    let guess = midnight + days * DAY + secs;
    (guess as i64 + offset(now) - offset(guess)) as u64
}
/// A custom snooze being set in the menu (T3 Code's CustomSnoozeDialog:
/// a date and time, or a duration).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) struct Custom {
    pub by_date: bool,
    pub amount: u64,
    /// 0 minutes, 1 hours, 2 days.
    pub unit: usize,
    /// Days after today, 0 to 6.
    pub day: u64,
    /// Minutes into that day.
    pub minute: u64,
}
const UNITS: [(&str, u64); 3] = [("min", 60), ("hours", HOUR), ("days", DAY)];
impl Custom {
    /// Two hours, or the next half hour an hour from now.
    pub(super) fn new(now: u64) -> Self {
        let (into, _) = local_day(now + HOUR);
        let minute = (into / 60).div_ceil(30) * 30;
        let (day, minute) = if minute >= 24 * 60 {
            (1, minute - 24 * 60)
        } else {
            (u64::from(local_day(now + HOUR).1 > local_day(now).1), minute)
        };
        Custom { by_date: false, amount: 2, unit: 1, day, minute }
    }
    /// When the snooze ends, or None when that is not ahead.
    pub(super) fn until(&self, now: u64) -> Option<u64> {
        let until = if self.by_date {
            at_local(now, self.day, self.minute * 60)
        } else {
            now + self.amount * UNITS[self.unit].1
        };
        (until > now).then_some(until)
    }
}
/// A click that edits the open Custom… panel.
fn setter(
    cx: &mut Context<ThreadList>,
    change: fn(&mut Custom),
) -> impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    cx.listener(move |this, _, _, cx| {
        if let Some(custom) = this.snooze_custom.as_mut() {
            change(custom);
        }
        cx.notify();
    })
}
/// The presets offered at `now`, in T3 Code's order: an hour, three hours,
/// this evening while it is still ahead, tomorrow morning and next Monday.
pub(super) fn presets(now: u64) -> Vec<(&'static str, u64)> {
    let mut presets = vec![("In 1 hour", now + HOUR), ("In 3 hours", now + 3 * HOUR)];
    let evening = at_hour(now, 0, 20);
    if evening > now + 3 * HOUR {
        presets.push(("This evening", evening));
    }
    presets.push(("Tomorrow", at_hour(now, 1, 9)));
    // Next Monday; on a Sunday that is tomorrow, so the Monday after.
    let today = weekday(now);
    let days = match (8 - today) % 7 {
        0 | 1 => (8 - today) % 7 + 7,
        n => n,
    };
    presets.push(("Next week", at_hour(now, days, 9)));
    presets
}
/// The local weekday at `at`, 0 for Sunday.
fn weekday(at: u64) -> u64 {
    let (_, midnight) = local_day(at);
    // 1970-01-01 was a Thursday.
    ((midnight as i64 + offset(at)) / DAY as i64 + 4).rem_euclid(7) as u64
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
        // This rebuild already shows every snooze that ended while closed.
        self.snoozes_woken_at = recents::now();
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
    /// A snooze whose time came since the list last rebuilt for one. The
    /// woken thread may land anywhere (needing input, working, pinned, out of
    /// scope), so each expiry is counted once by time, not by its marker.
    pub(super) fn snooze_due(&self) -> bool {
        let now = recents::now();
        self.snoozes
            .values()
            .any(|until| *until <= now && *until > self.snoozes_woken_at)
    }
    pub(super) fn save_snoozes(&self, cx: &mut Context<Self>) {
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
    /// The row menu's Snooze entry. The full menu offers "Snooze…", which
    /// turns the menu into the preset list; the card's clock opens that list
    /// directly (T3 Code's snooze menu). A snoozed thread offers Unsnooze.
    pub(super) fn snooze_items(&self, id: &str, only: bool, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if !self.snoozable(id) {
            return vec![];
        }
        let now = recents::now();
        let item = |selector: String, name: AnyElement, hint: Option<String>| {
            div()
                .id(gpui::ElementId::Name(selector.clone().into()))
                .debug_selector(move || selector.clone())
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
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(div().flex_1().child(name))
                .map(move |row| match hint {
                    Some(hint) => row.child(
                        div()
                            .pl(px(16.))
                            .text_color(theme().text_faint)
                            .child(hint),
                    ),
                    None => row,
                })
        };
        if self.snoozed(id) {
            let id = id.to_owned();
            return vec![
                item("sidebar-row-unsnooze".into(), "Unsnooze".into_any_element(), None)
                    .on_click(cx.listener(move |this, _, _, cx| this.snooze(id.clone(), None, cx)))
                    .into_any_element(),
            ];
        }
        if !only {
            return vec![
                item("sidebar-row-snooze".into(), "Snooze…".into_any_element(), None)
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(menu) = this.row_menu.as_mut() {
                            menu.snooze_only = true;
                        }
                        cx.notify();
                    }))
                    .into_any_element(),
            ];
        }
        let heading = div()
            .px(px(8.))
            .pt(px(4.))
            .pb(px(2.))
            .text_size(px(11.5))
            .text_color(theme().text_muted)
            .child("Snooze until")
            .into_any_element();
        let mut items: Vec<AnyElement> = std::iter::once(heading)
            .chain(presets(now).into_iter().enumerate().map(|(i, (name, until))| {
                let id = id.to_owned();
                item(
                    format!("sidebar-row-snooze-{i}"),
                    name.into_any_element(),
                    Some(until_label(until, now)),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.row_menu = None;
                    this.snooze(id.clone(), Some(until), cx)
                }))
                .into_any_element()
            }))
            .collect();
        match self.snooze_custom {
            None => items.push(
                item("sidebar-row-snooze-custom".into(), "Custom…".into_any_element(), None)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.snooze_custom = Some(Custom::new(recents::now()));
                        cx.notify();
                    }))
                    .into_any_element(),
            ),
            Some(custom) => items.push(self.custom_panel(id, custom, now, cx)),
        }
        items
    }
    /// Custom… opens in place: Duration (an amount and a unit) or Date and
    /// time (the next seven days and a half-hour clock).
    fn custom_panel(&self, id: &str, custom: Custom, now: u64, cx: &mut Context<Self>) -> AnyElement {
        let chip = |selector: String, label: String, on: bool| {
            div()
                .id(gpui::ElementId::Name(selector.clone().into()))
                .debug_selector(move || selector.clone())
                .h(px(24.))
                .px(px(8.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .text_size(px(12.))
                .cursor_pointer()
                .text_color(if on { theme().text } else { theme().text_muted })
                .when(on, |c| c.bg(theme().selection))
                .when(!on, |c| c.hover(|s| s.bg(theme().hover)))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(label)
        };
        let step = |selector: &'static str, glyph: &'static str| {
            div()
                .id(selector)
                .debug_selector(move || selector.into())
                .size(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .text_size(px(14.))
                .text_color(theme().text_muted)
                .cursor_pointer()
                .hover(|s| s.bg(theme().hover))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(glyph)
        };
        let mode = div()
            .flex()
            .gap(px(2.))
            .p(px(2.))
            .rounded(px(8.))
            .bg(theme().hover)
            .child(
                chip("sidebar-snooze-custom-duration".into(), "Duration".into(), !custom.by_date)
                    .flex_1()
                    .on_click(setter(cx, |c| c.by_date = false)),
            )
            .child(
                chip("sidebar-snooze-custom-date".into(), "Date and time".into(), custom.by_date)
                    .flex_1()
                    .on_click(setter(cx, |c| c.by_date = true)),
            );
        let body = if custom.by_date {
            let days = (0..7u64).map(|day| {
                let label = match day {
                    0 => "Today".to_owned(),
                    1 => "Tmrw".to_owned(),
                    _ => {
                        let at = at_local(now, day, 12 * HOUR);
                        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(at) as usize].to_owned()
                    }
                };
                let pick: fn(&mut Custom) = match day {
                    0 => |c| c.day = 0,
                    1 => |c| c.day = 1,
                    2 => |c| c.day = 2,
                    3 => |c| c.day = 3,
                    4 => |c| c.day = 4,
                    5 => |c| c.day = 5,
                    _ => |c| c.day = 6,
                };
                chip(format!("sidebar-snooze-custom-day-{day}"), label, custom.day == day)
                    .flex_1()
                    .px(px(0.))
                    .text_size(px(11.5))
                    .on_click(setter(cx, pick))
            }).collect::<Vec<_>>();
            let clock = until_label(at_local(now, 0, custom.minute * 60), now);
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(div().flex().gap(px(1.)).children(days))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(step("sidebar-snooze-custom-earlier", "−").on_click(setter(cx, |c| {
                            c.minute = (c.minute + 24 * 60 - 30) % (24 * 60)
                        })))
                        .child(div().flex_1().flex().justify_center().text_size(px(13.)).child(clock))
                        .child(step("sidebar-snooze-custom-later", "+").on_click(setter(cx, |c| {
                            c.minute = (c.minute + 30) % (24 * 60)
                        }))),
                )
                .into_any_element()
        } else {
            let units = UNITS.iter().enumerate().map(|(i, (name, _))| {
                let pick: fn(&mut Custom) = match i {
                    0 => |c| c.unit = 0,
                    1 => |c| c.unit = 1,
                    _ => |c| c.unit = 2,
                };
                chip(format!("sidebar-snooze-custom-unit-{i}"), (*name).into(), custom.unit == i)
                    .on_click(setter(cx, pick))
            }).collect::<Vec<_>>();
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(step("sidebar-snooze-custom-less", "−").on_click(setter(cx, |c| {
                    c.amount = c.amount.saturating_sub(1).max(1)
                })))
                .child(
                    div()
                        .debug_selector(|| "sidebar-snooze-custom-amount".into())
                        .w(px(28.))
                        .flex()
                        .justify_center()
                        .text_size(px(13.))
                        .child(custom.amount.to_string()),
                )
                .child(step("sidebar-snooze-custom-more", "+").on_click(setter(cx, |c| {
                    c.amount = (c.amount + 1).min(99)
                })))
                .child(div().flex().gap(px(2.)).children(units))
                .into_any_element()
        };
        let until = custom.until(now);
        let id = id.to_owned();
        let confirm = div()
            .id("sidebar-snooze-custom-confirm")
            .debug_selector(|| "sidebar-snooze-custom-confirm".into())
            .h(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(7.))
            .text_size(px(12.5))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .map(|button| match until {
                Some(until) => button
                    .bg(theme().accent)
                    .text_color(gpui::white())
                    .cursor_pointer()
                    .child(format!("Snooze until {}", until_label(until, now)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.snooze_custom = None;
                        this.snooze(id.clone(), Some(until), cx)
                    })),
                None => button
                    .bg(theme().hover)
                    .text_color(theme().text_faint)
                    .child("Pick a time ahead"),
            });
        div()
            .mt(px(4.))
            .pt(px(6.))
            .px(px(4.))
            .pb(px(2.))
            .border_t_1()
            .border_color(theme().border)
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(mode)
            .child(body)
            .child(confirm)
            .into_any_element()
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presets_are_ahead_and_ordered() {
        let now = 1_793_000_000;
        let presets = presets(now);
        assert_eq!(presets[0], ("In 1 hour", now + HOUR));
        assert_eq!(presets.last().unwrap().0, "Next week");
        assert_eq!(weekday(presets.last().unwrap().1), 1);
        assert!(presets.windows(2).all(|w| w[0].1 < w[1].1));
        let (into, _) = local_day(presets.last().unwrap().1);
        assert_eq!(into, 9 * HOUR);
    }
    #[test]
    fn custom_snooze_counts_a_duration_or_lands_on_a_local_time() {
        let now = 1_793_000_000;
        let mut custom = Custom::new(now);
        assert_eq!(custom.until(now), Some(now + 2 * HOUR), "two hours by default");
        custom.unit = 2;
        custom.amount = 3;
        assert_eq!(custom.until(now), Some(now + 3 * DAY));
        custom.by_date = true;
        custom.day = 1;
        custom.minute = 9 * 60 + 30;
        let until = custom.until(now).unwrap();
        assert_eq!(local_day(until).0, 9 * HOUR + 30 * 60);
        assert!(until_label(until, now).ends_with(" 9:30 AM"));
        // A time already gone today offers nothing.
        custom.day = 0;
        custom.minute = (local_day(now).0 / 60).saturating_sub(30);
        assert_eq!(custom.until(now), None);
        // The default date is a half hour, an hour or more ahead.
        let fresh = Custom::new(now);
        let at = at_local(now, fresh.day, fresh.minute * 60);
        assert!(at >= now + HOUR && at < now + HOUR + 30 * 60 + 60, "{at} vs {now}");
    }
    #[test]
    fn labels_read_local_clock_times() {
        let now = 1_793_000_000;
        assert!(!until_label(now + HOUR, now).is_empty());
        let tomorrow = at_hour(now, 1, 9);
        assert!(until_label(tomorrow, now).ends_with(" 9 AM"));
    }
}
