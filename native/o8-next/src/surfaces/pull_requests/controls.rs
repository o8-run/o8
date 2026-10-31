//! The list's control row, as desktop pull-requests/controls.tsx draws it:
//! search, then Sort, Filters, State, Involvement and Layout pickers and a
//! refresh button, each 36px with a menu anchored under it.
use super::*;

pub(super) const SEARCH: &str = "m21 21-4.34-4.34 M11 3a8 8 0 1 0 0 16 8 8 0 1 0 0-16Z";
const ARROW_DOWN: &str = "M12 5v14 M19 12l-7 7-7-7";
const ARROW_UP: &str = "m5 12 7-7 7 7 M12 19V5";
const SLIDERS: &str = "M10 5H3 M12 19H3 M14 3v4 M16 17v4 M21 12h-9 M21 19h-5 M21 5h-7 M8 10v4";
pub(super) const LAYERS: &str = "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12 M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17";
pub(super) const PENCIL: &str = "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z M15 5l4 4";
const EYE: &str = "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0 M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z";
pub(super) const USER: &str = "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z M12 7a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662";
const REFRESH: &str = "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5";
const CHEVRON: &str = "m6 9 6 6 6-6";
const CHECK: &str = "M20 6 9 17l-5-5";
const CLOSE: &str = "M18 6 6 18 M6 6l12 12";

/// PR_CONTROL: the 36px bordered control every picker and button shares.
pub(super) fn control(id: String) -> gpui::Stateful<gpui::Div> {
    let selector = id.clone();
    div()
        .id(gpui::SharedString::from(id))
        .debug_selector(move || selector.clone())
        .h(px(36.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(7.))
        .px(px(11.))
        .rounded(px(10.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface_raised)
        .text_size(px(13.))
        .text_color(theme().text)
}

pub(super) fn icon(path: &str, size: f32) -> impl IntoElement {
    crate::icon::stroke(path, theme().text_secondary, size, 1.8)
}

/// One picker: its options as (value, label, icon).
struct Picker {
    id: &'static str,
    value: String,
    icon: &'static str,
    options: Vec<(&'static str, &'static str, Option<&'static str>)>,
    enabled: bool,
}

impl PullRequests {
    fn pickers(&self) -> [Picker; 4] {
        [
            Picker {
                id: "sort",
                value: self.sort.clone(),
                icon: if self.sort == "oldest" { ARROW_UP } else { ARROW_DOWN },
                options: vec![
                    ("updated", "Updated", None),
                    ("oldest", "Oldest", None),
                    ("newest", "Newest", None),
                ],
                enabled: !self.loading,
            },
            Picker {
                id: "state",
                value: self.state.clone(),
                icon: match self.state.as_str() {
                    "merged" => ICON_MERGED,
                    "all" => LAYERS,
                    _ => ICON_PR,
                },
                options: vec![
                    ("open", "Open", Some(ICON_PR)),
                    ("closed", "Closed", Some(ICON_PR)),
                    ("merged", "Merged", Some(ICON_MERGED)),
                    ("all", "All", Some(LAYERS)),
                ],
                enabled: !self.loading,
            },
            Picker {
                id: "scope",
                value: self.scope.clone(),
                icon: match self.scope.as_str() {
                    "authored" => PENCIL,
                    "reviewing" => EYE,
                    _ => LAYERS,
                },
                options: vec![
                    ("all", "All authors", Some(LAYERS)),
                    ("authored", "Authored", Some(PENCIL)),
                    ("reviewing", "Review requested", Some(EYE)),
                    ("others", "Others", Some(USER)),
                ],
                enabled: !self.viewer.is_empty(),
            },
            Picker {
                id: "layout",
                value: self.layout.clone(),
                icon: if self.layout == "stacks" { LAYERS } else { USER },
                options: vec![("authors", "By author", None), ("stacks", "Branch stacks", None)],
                enabled: true,
            },
        ]
    }

    fn toggle_menu(&mut self, id: &'static str, cx: &mut Context<Self>) {
        self.menu = (self.menu != Some(id)).then_some(id);
        self.filter_field = None;
        self.changed(cx);
    }

    fn picker(&self, picker: Picker, cx: &mut Context<Self>) -> AnyElement {
        let Picker { id, value, icon: glyph, options, enabled } = picker;
        let open = self.menu == Some(id);
        let label = options
            .iter()
            .find(|(v, _, _)| *v == value)
            .map_or("", |(_, label, _)| label);
        let trigger = control(format!("pr-{id}"))
            .opacity(if enabled { 1. } else { 0.5 })
            .when(enabled, |c| c.cursor_pointer().hover(|c| c.bg(theme().hover)))
            .child(icon(glyph, 15.))
            .child(label)
            .child(icon(CHEVRON, 12.))
            .on_click(cx.listener(move |s, _, _, cx| {
                if enabled {
                    s.toggle_menu(id, cx);
                }
            }));
        let menu = open.then(|| {
            let rows = options.into_iter().map(|(option, label, glyph)| {
                let chosen = option == value;
                menu_row(format!("pr-{id}-{option}"), chosen)
                    .children(glyph.map(|g| icon(g, 16.)))
                    .child(div().flex_1().child(label))
                    .when(chosen, |row| row.child(icon(CHECK, 14.)))
                    .on_click(cx.listener(move |s, _, _, cx| {
                        s.menu = None;
                        let next = option.to_owned();
                        match id {
                            "sort" => s.sort = next,
                            "state" => s.state = next,
                            "scope" => s.scope = next,
                            _ => s.layout = next,
                        }
                        if matches!(id, "state" | "sort") {
                            s.rows.clear();
                            s.load(false, cx);
                        } else {
                            s.changed(cx);
                        }
                    }))
                    .into_any_element()
            });
            popover(format!("pr-{id}-menu"), 200., div().p(px(6.)).children(rows), cx)
        });
        div()
            .relative()
            .flex_shrink_0()
            .child(trigger)
            .children(menu)
            .into_any_element()
    }

    /// The filter fields: Author, Label, Base branch, Readiness and Checks.
    fn filter_fields(&self) -> Vec<(&'static str, &'static str, Vec<(String, String)>)> {
        let found = |key: &str| {
            let mut values: Vec<String> = if key == "label" {
                self.rows
                    .iter()
                    .flat_map(|p| array(p, "labels"))
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            } else {
                self.rows.iter().map(|p| string(p, key).to_owned()).collect()
            };
            values.sort();
            values.dedup();
            values.into_iter().map(|v| (v.clone(), v)).collect::<Vec<_>>()
        };
        let fixed = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(v, l)| ((*v).to_owned(), (*l).to_owned()))
                .collect::<Vec<_>>()
        };
        vec![
            ("author", "Author", found("author")),
            ("label", "Label", found("label")),
            ("baseRefName", "Base branch", found("baseRefName")),
            ("draft", "Readiness", fixed(&[("ready", "Ready for review"), ("draft", "Draft")])),
            (
                "checks",
                "Checks",
                fixed(&[
                    ("success", "Passing"),
                    ("failure", "Failing"),
                    ("pending", "Pending"),
                    ("unknown", "Not available"),
                ]),
            ),
        ]
    }

    fn filters_control(&self, cx: &mut Context<Self>) -> AnyElement {
        let count = self.filters.values().filter(|v| !v.is_empty()).count();
        let open = self.menu == Some("filters");
        let trigger = control("pr-filters".into())
            .cursor_pointer()
            .hover(|c| c.bg(theme().hover))
            .when(count > 0, |c| c.border_color(theme().accent))
            .child(icon(SLIDERS, 15.))
            .child("Filters")
            .when(count > 0, |c| {
                c.child(div().text_color(theme().accent).child(count.to_string()))
            })
            .on_click(cx.listener(|s, _, _, cx| s.toggle_menu("filters", cx)));
        let panel = open.then(|| {
            let mut body = div().p(px(14.)).flex().flex_col().gap(px(12.)).child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("Filters"),
                    )
                    .child(
                        div()
                            .id("pr-filters-close")
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(8.))
                            .cursor_pointer()
                            .hover(|c| c.bg(theme().hover))
                            .child(icon(CLOSE, 14.))
                            .on_click(cx.listener(|s, _, _, cx| {
                                s.menu = None;
                                s.changed(cx);
                            })),
                    ),
            );
            for (key, label, options) in self.filter_fields() {
                let current = self.filters.get(key).cloned().unwrap_or_default();
                let shown = options
                    .iter()
                    .find(|(v, _)| *v == current)
                    .map_or("Any".to_owned(), |(_, l)| l.clone());
                let expanded = self.filter_field == Some(key);
                let mut field = div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .text_size(px(12.))
                    .text_color(theme().text_secondary)
                    .child(label)
                    .child(
                        control(format!("pr-filter-{key}"))
                            .w_full()
                            .justify_between()
                            .cursor_pointer()
                            .hover(|c| c.bg(theme().hover))
                            .child(div().min_w_0().truncate().child(shown))
                            .child(icon(CHEVRON, 12.))
                            .on_click(cx.listener(move |s, _, _, cx| {
                                s.filter_field = (s.filter_field != Some(key)).then_some(key);
                                s.changed(cx);
                            })),
                    );
                if expanded {
                    let choices = std::iter::once((String::new(), "Any".to_owned()))
                        .chain(options)
                        .map(|(value, text)| {
                            let chosen = value == current;
                            let id = if value.is_empty() { "any".to_owned() } else { value.clone() };
                            menu_row(format!("pr-filter-{key}-{id}"), chosen)
                                .child(div().flex_1().min_w_0().truncate().child(text))
                                .when(chosen, |row| row.child(icon(CHECK, 14.)))
                                .on_click(cx.listener(move |s, _, _, cx| {
                                    s.filters.insert(key, value.clone());
                                    s.filter_field = None;
                                    s.changed(cx);
                                }))
                        });
                    field = field.child(
                        div()
                            .id(gpui::SharedString::from(format!("pr-filter-{key}-options")))
                            .max_h(px(180.))
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .children(choices),
                    );
                }
                body = body.child(field);
            }
            body = body.child(
                div()
                    .mt(px(4.))
                    .flex()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        control("pr-filters-reset".into())
                            .cursor_pointer()
                            .hover(|c| c.bg(theme().hover))
                            .child("Reset filters")
                            .on_click(cx.listener(|s, _, _, cx| {
                                s.filters.clear();
                                s.filter_field = None;
                                s.changed(cx);
                            })),
                    )
                    .child(
                        control("pr-filters-done".into())
                            .cursor_pointer()
                            .hover(|c| c.bg(theme().hover))
                            .child("Done")
                            .on_click(cx.listener(|s, _, _, cx| {
                                s.menu = None;
                                s.filter_field = None;
                                s.changed(cx);
                            })),
                    ),
            );
            popover("pr-filters-menu".into(), 280., body, cx)
        });
        div()
            .relative()
            .flex_shrink_0()
            .child(trigger)
            .children(panel)
            .into_any_element()
    }

    /// The header's control row.
    pub(super) fn controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let [sort, state, scope, layout] = self.pickers();
        // flex: 1 1 220px, as the desktop search field.
        let search = control("pr-search".into())
            .flex_grow()
            .flex_shrink()
            .flex_basis(px(220.))
            .justify_start()
            .child(icon(SEARCH, 15.))
            .child(div().flex_1().min_w_0().child(self.search.clone()));
        let refresh = control("pr-refresh".into())
            .w(px(36.))
            .px_0()
            .opacity(if self.loading { 0.5 } else { 1. })
            .when(!self.loading, |c| c.cursor_pointer().hover(|c| c.bg(theme().hover)))
            .child(icon(REFRESH, 15.))
            .on_click(cx.listener(|s, _, _, cx| {
                if s.loading {
                    return;
                }
                s.load(false, cx);
                if let Some(n) = s.selected.filter(|_| !s.hosted) {
                    s.select(n, cx);
                }
            }));
        div()
            .w_full()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .child(search)
            .child(self.picker(sort, cx))
            .child(self.filters_control(cx))
            .child(self.picker(state, cx))
            .child(self.picker(scope, cx))
            .child(self.picker(layout, cx))
            .child(refresh)
            .into_any_element()
    }
}

pub(super) fn menu_row(id: String, chosen: bool) -> gpui::Stateful<gpui::Div> {
    let selector = id.clone();
    div()
        .id(gpui::SharedString::from(id))
        .debug_selector(move || selector.clone())
        .w_full()
        .min_h(px(36.))
        .px(px(10.))
        .py(px(8.))
        .flex()
        .items_center()
        .gap(px(10.))
        .rounded(px(8.))
        .text_size(px(13.))
        .text_color(theme().text)
        .cursor_pointer()
        .when(chosen, |row| row.bg(theme().hover))
        .hover(|row| row.bg(theme().hover))
}

/// A floating surface under its trigger; a click outside closes it.
pub(super) fn popover(
    id: String,
    width: f32,
    body: impl IntoElement,
    cx: &mut Context<PullRequests>,
) -> AnyElement {
    let selector = id.clone();
    div()
        .absolute()
        .left_0()
        .top(px(42.))
        .child(
            gpui::deferred(
                gpui::anchored().position(gpui::point(px(0.), px(0.))).child(
                    div()
                        .id("pr-menu-backdrop")
                        .w(px(100_000.))
                        .h(px(100_000.))
                        .on_mouse_down(
                            gpui::MouseButton::Left,
                            cx.listener(|s, _, _, cx| {
                                s.menu = None;
                                s.filter_field = None;
                                s.changed(cx);
                            }),
                        ),
                ),
            )
            .with_priority(1),
        )
        .child(
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::TopLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(
                        div()
                            .id(gpui::SharedString::from(id))
                            .debug_selector(move || selector.clone())
                            .occlude()
                            .w(px(width))
                            .max_h(px(520.))
                            .overflow_y_scroll()
                            .rounded(px(14.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .font_weight(gpui::FontWeight::NORMAL)
                            .child(body),
                    ),
            )
            .with_priority(2),
        )
        .into_any_element()
}
