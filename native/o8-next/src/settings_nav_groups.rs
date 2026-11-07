//! The Settings sidebar as classic has it: headed groups of tabs, and a flyout
//! on each tab that lists what it holds and jumps there.
use super::*;
use crate::settings_fields::SECTIONS;
use crate::theme::current as theme;
use gpui::{
    AnyElement, Corner, Div, SharedString, Stateful, anchored, deferred, div, point, prelude::*, px,
};
use std::time::Duration;

const OPEN_DELAY: Duration = Duration::from_millis(180);
const CLOSE_DELAY: Duration = Duration::from_millis(160);

pub(super) const NAV: &[(&str, &[&str])] = &[
    (
        "General",
        &["general", "appearance", "voice", "keyboard", "bots"],
    ),
    (
        "Agents",
        &["dispatch", "models", "local-models", "providers", "keys"],
    ),
    ("Workspace", &["storage", "git", "indexing"]),
    ("Connections", &["mcp", "machines", "mobile", "connections"]),
    ("System", &["limits", "diagnostics", "about"]),
];

/// The sidebar child that shows a tab, counting the group headings.
pub(super) fn nav_index(section: &str) -> Option<usize> {
    let mut index = 0;
    for (_, tabs) in NAV {
        index += 1;
        if let Some(at) = tabs.iter().position(|tab| *tab == section) {
            return Some(index + at);
        }
        index += tabs.len();
    }
    None
}

/// Headings a tab's own panel draws above any fields. Choosing one opens the
/// tab; field groups below also scroll to their heading.
const PANEL_GROUPS: &[(&str, &[&str])] = &[
    ("appearance", &["Theme", "Chat width"]),
    ("about", &["Version", "Links", "Credits"]),
    (
        "diagnostics",
        &["Shipped feature audit", "Thread switches", "Maintenance"],
    ),
    (
        "storage",
        &["Storage usage", "Fleet parking", "Storage categories"],
    ),
    ("indexing", &["Repositories"]),
    ("mobile", &["Remote access", "Pairing", "Paired devices"]),
];

/// Parts of a tab that open in place of its fields, listed after them.
pub(super) const VOICE_HISTORY: &str = "History";
const TRAILING_PANELS: &[(&str, &[&str])] = &[("voice", &[VOICE_HISTORY])];

/// The headings a tab's page shows, in page order.
pub(super) fn groups_of(section: &str) -> Vec<&'static str> {
    let mut groups: Vec<&'static str> = PANEL_GROUPS
        .iter()
        .find(|(id, _)| *id == section)
        .map_or(vec![], |(_, groups)| groups.to_vec());
    for field in fields().filter(|field| field.section == section) {
        if !groups.contains(&field.group()) {
            groups.push(field.group());
        }
    }
    if let Some((_, trailing)) = TRAILING_PANELS.iter().find(|(id, _)| *id == section) {
        groups.extend_from_slice(trailing);
    }
    groups
}

fn label_of(section: &str) -> &'static str {
    SECTIONS
        .iter()
        .find(|(id, _)| *id == section)
        .map_or("", |(_, label)| *label)
}

impl Settings {
    pub(super) fn navigation_list(
        &mut self,
        mut list: Stateful<Div>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        for (index, (heading, tabs)) in NAV.iter().enumerate() {
            list = list.child(
                div()
                    .debug_selector(move || format!("settings-nav-heading-{heading}"))
                    .when(index > 0, |v| v.mt(px(10.)))
                    .px(px(10.))
                    .flex_shrink_0()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(*heading),
            );
            for id in tabs.iter().copied() {
                list = list.child(self.nav_row(id, window, cx));
            }
        }
        list
    }

    fn nav_row(
        &mut self,
        id: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let enabled = !self.busy && self.editor.is_none();
        let groups = groups_of(id);
        let chevron = div()
            .id(SharedString::from(format!("settings-nav-more-{id}")))
            .debug_selector(move || format!("settings-nav-more-{id}"))
            .w(px(20.))
            .h(px(26.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .when(!groups.is_empty(), |v| {
                v.cursor_pointer()
                    .child(crate::icon::stroke(
                        "m9 5 7 7-7 7",
                        theme().text_faint,
                        11.,
                        2.,
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.navigation.flyout = Some(id);
                        this.navigation.flyout_wait += 1;
                        cx.notify();
                    }))
            });
        let button = self
            .button(
                format!("settings-nav-{id}"),
                label_of(id).into(),
                enabled,
                self.section == id,
                window,
                cx,
                move |this, _, cx| {
                    this.close_flyout(cx);
                    this.select(id, cx);
                },
            )
            .flex_1()
            .min_w_0()
            // Classic's tabs are flat; only the open one has a fill.
            .when(self.section != id, |row| row.bg(gpui::transparent_black()));
        let flyout =
            (self.navigation.flyout == Some(id)).then(|| self.flyout(id, groups, window, cx));
        div()
            .id(SharedString::from(format!("settings-nav-row-{id}")))
            .relative()
            .flex()
            .items_center()
            .flex_shrink_0()
            .on_hover(
                cx.listener(move |this, hovering: &bool, _, cx| this.tab_hover(id, *hovering, cx)),
            )
            .child(button)
            .child(chevron)
            .children(flyout.map(|panel| {
                div().absolute().top_0().right_0().child(
                    deferred(
                        anchored()
                            .anchor(Corner::TopLeft)
                            .offset(point(px(6.), px(-5.)))
                            .snap_to_window_with_margin(px(12.))
                            .child(panel),
                    )
                    .with_priority(1),
                )
            }))
            .into_any_element()
    }

    fn flyout(
        &mut self,
        id: &'static str,
        groups: Vec<&'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let enabled = !self.busy && self.editor.is_none();
        let mut items = Vec::with_capacity(groups.len());
        for (index, group) in groups.into_iter().enumerate() {
            let control = format!("settings-nav-group-{id}-{index}");
            items.push(
                self.button(
                    control.clone(),
                    group.into(),
                    enabled,
                    false,
                    window,
                    cx,
                    move |this, window, cx| this.jump_to_group(id, group, window, cx),
                )
                .w_full()
                .bg(gpui::transparent_black()),
            );
            if index == 0 && std::mem::take(&mut self.navigation.flyout_focus) {
                if let Some(focus) = self.controls.get(&control) {
                    focus.focus(window);
                }
            }
        }
        div()
            .id("settings-nav-flyout")
            .debug_selector(|| "settings-nav-flyout".into())
            .occlude()
            .min_w(px(180.))
            .max_w(px(260.))
            .rounded(px(12.))
            .p(px(5.))
            .flex()
            .flex_col()
            .gap(px(1.))
            .bg(crate::theme::popover_background())
            .border_1()
            .border_color(theme().border)
            .shadow_lg()
            .on_hover(cx.listener(|this, hovering: &bool, _, cx| this.flyout_hover(*hovering, cx)))
            .on_mouse_down_out(cx.listener(|this, _, _, cx| this.close_flyout(cx)))
            .child(
                div()
                    .px(px(10.))
                    .py(px(6.))
                    .text_size(px(11.))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme().text_muted)
                    .child(format!("{} sections", label_of(id))),
            )
            .children(items)
            .into_any_element()
    }

    /// The pointer resting on a tab opens its flyout; leaving both closes it. A
    /// flyout opened from the keyboard stays until Escape or a choice. Moving
    /// from a tab into its flyout reports both edges in either order, so only
    /// where the pointer ended up counts.
    fn tab_hover(&mut self, id: &'static str, hovering: bool, cx: &mut Context<Self>) {
        if hovering {
            self.navigation.over_tab = Some(id);
        } else if self.navigation.over_tab == Some(id) {
            self.navigation.over_tab = None;
        }
        self.settle_flyout(cx);
    }

    fn flyout_hover(&mut self, hovering: bool, cx: &mut Context<Self>) {
        self.navigation.over_flyout = hovering;
        self.settle_flyout(cx);
    }

    fn settle_flyout(&mut self, cx: &mut Context<Self>) {
        self.navigation.flyout_wait += 1;
        let wait = self.navigation.flyout_wait;
        if self.navigation.flyout_keyboard || self.navigation.over_flyout {
            return;
        }
        let delay = if self.navigation.over_tab.is_some() {
            OPEN_DELAY
        } else {
            CLOSE_DELAY
        };
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |this, cx| {
                let next = this
                    .navigation
                    .over_tab
                    .filter(|id| !groups_of(id).is_empty() && !this.busy && this.editor.is_none());
                if this.navigation.flyout_wait == wait && this.navigation.flyout != next {
                    this.navigation.flyout = next;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn close_flyout(&mut self, cx: &mut Context<Self>) {
        self.navigation.flyout_wait += 1;
        self.navigation.flyout_keyboard = false;
        self.navigation.over_flyout = false;
        if self.navigation.flyout.take().is_some() {
            cx.notify();
        }
    }

    fn jump_to_group(
        &mut self,
        id: &'static str,
        group: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_flyout(cx);
        self.select(id, cx);
        if id == "voice" && group == VOICE_HISTORY {
            // select() has just started reading settings, so it's busy; the
            // panel switch reads only the local file and needs no wait.
            if self.section == "voice" {
                self.voice_panel = VoicePanel::History;
                self.load_panel(false, cx);
            }
        } else if let Some(field) = fields().find(|f| f.section == id && f.group() == group) {
            self.navigation.aim_group(field.id);
        }
        self.focus.focus(window);
    }

    /// Right arrow on a focused tab opens its flyout at the first section.
    pub(super) fn open_focused_flyout(&mut self, window: &Window, cx: &mut Context<Self>) -> bool {
        let focused = SECTIONS.iter().map(|(id, _)| *id).find(|id| {
            self.controls
                .get(&format!("settings-nav-{id}"))
                .is_some_and(|focus| focus.is_focused(window))
        });
        let Some(id) = focused.filter(|id| !groups_of(id).is_empty()) else {
            return false;
        };
        self.navigation.flyout_wait += 1;
        self.navigation.flyout = Some(id);
        self.navigation.flyout_keyboard = true;
        self.navigation.flyout_focus = true;
        cx.notify();
        true
    }

    /// Escape closes an open flyout first and returns to its tab.
    pub(super) fn dismiss_flyout(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(id) = self.navigation.flyout else {
            return false;
        };
        self.close_flyout(cx);
        if let Some(focus) = self.controls.get(&format!("settings-nav-{id}")) {
            focus.focus(window);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tab_sits_in_exactly_one_group() {
        for (id, _) in SECTIONS {
            let homes = NAV.iter().filter(|(_, tabs)| tabs.contains(id)).count();
            assert_eq!(homes, 1, "{id}");
        }
        assert_eq!(
            NAV.iter().map(|(_, tabs)| tabs.len()).sum::<usize>(),
            SECTIONS.len()
        );
    }

    #[test]
    fn sidebar_positions_count_the_headings() {
        assert_eq!(nav_index("general"), Some(1));
        assert_eq!(nav_index("bots"), Some(5));
        assert_eq!(nav_index("dispatch"), Some(7));
        assert_eq!(nav_index("nowhere"), None);
    }

    #[test]
    fn a_tab_lists_its_page_headings_once_and_in_order() {
        let groups = groups_of("git");
        assert_eq!(groups, ["Branches", "Commits", "Pull requests"]);
        assert!(groups_of("machines").is_empty());
    }
}
