//! The Projects page's repository icon picker: a glyph and color, an emoji, a
//! monogram and color, or an image inside the repository, saved through
//! POST /api/panel/repos {action: 'update-icon'}.
//!
//! Adapted from T3 Code (https://github.com/pingdotgg/t3code),
//! apps/web/src/components/settings/ProjectIconPickerDialog.tsx and
//! apps/web/src/projectIconOptions.ts (filterProjectIconNames), commit
//! f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
//! MIT; full notice retained in licenses/t3code-MIT.txt.
//! Adaptations: an inline card on the repository row rather than a dialog;
//! T3's separate favicon picker is the Image tab's repository path; Use
//! automatic clears both choices; native offers T3's 24 popular glyphs.
use super::view::{control, field};
use super::*;
use crate::project_icon::{self as icons, Icon};
use crate::theme::current as theme;
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Mode {
    Glyph,
    Emoji,
    Monogram,
    Image,
}

/// The picker's draft for one repository, started from its current icon.
pub(super) struct Picker {
    pub repo: String,
    name: String,
    mode: Mode,
    glyph: String,
    color: &'static str,
    pub emoji: String,
}

fn palette(color: &str) -> Option<&'static str> {
    icons::COLORS
        .iter()
        .find(|(name, _)| *name == color)
        .map(|(name, _)| *name)
}

impl Projects {
    pub(super) fn open_icon(&mut self, repo: &Repo, cx: &mut Context<Self>) {
        let (mut letters, color) = icons::derive(&repo.name);
        let mut path = String::new();
        let mut picker = Picker {
            repo: repo.id.clone(),
            name: repo.name.clone(),
            mode: Mode::Glyph,
            glyph: icons::DEFAULT_GLYPH.into(),
            color,
            emoji: "💻".into(),
        };
        match &repo.icon {
            Some(Icon::Glyph { name, color }) => {
                picker.glyph = name.clone();
                picker.color = palette(color).unwrap_or(picker.color);
            }
            Some(Icon::Emoji { emoji }) => {
                picker.mode = Mode::Emoji;
                picker.emoji = emoji.clone();
            }
            Some(Icon::Monogram { text, color }) => {
                picker.mode = Mode::Monogram;
                picker.color = palette(color).unwrap_or(picker.color);
                letters = text.clone();
            }
            Some(Icon::Image { path: chosen }) => {
                picker.mode = Mode::Image;
                path = chosen.clone();
            }
            None => {}
        }
        for (input, value) in [
            (&self.icon_search, String::new()),
            (&self.icon_letters, letters),
            (&self.icon_emoji, String::new()),
            (&self.icon_path, path),
        ] {
            input.update(cx, |input, cx| {
                input.clear(cx);
                input.text = value;
                cx.notify();
            });
        }
        self.icon = Some(picker);
        self.error = None;
        cx.notify();
    }
    /// The update-icon patch the draft saves, when it is complete. An image
    /// clears the identity override, which would otherwise win over it.
    fn icon_patch(&self, cx: &App) -> Option<Value> {
        let picker = self.icon.as_ref()?;
        match picker.mode {
            Mode::Glyph => Some(json!({"projectIcon": {
                "kind": "lucide", "name": picker.glyph, "color": picker.color,
            }})),
            Mode::Emoji => Some(json!({"projectIcon": {"kind": "emoji", "emoji": picker.emoji}})),
            Mode::Monogram => icons::monogram(&self.icon_letters.read(cx).text).map(|text| {
                json!({"projectIcon": {"kind": "monogram", "text": text, "color": picker.color}})
            }),
            Mode::Image => {
                let path = self.icon_path.read(cx).text.trim().to_owned();
                (!path.is_empty()).then(|| json!({"projectIcon": null, "faviconPath": path}))
            }
        }
    }
    fn icon_set(&mut self, cx: &mut Context<Self>, set: impl FnOnce(&mut Picker)) {
        if let Some(picker) = self.icon.as_mut() {
            set(picker);
        }
        cx.notify();
    }
    pub(super) fn icon_picker(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let picker = self.icon.as_ref()?;
        let enabled = !self.busy && !self.loading;
        let repo = picker.repo.clone();
        let patch = self.icon_patch(cx);
        let tabs = [
            (Mode::Glyph, "glyph", "Icons"),
            (Mode::Emoji, "emoji", "Emoji"),
            (Mode::Monogram, "monogram", "Monogram"),
            (Mode::Image, "image", "Image"),
        ]
        .into_iter()
        .map(|(mode, key, label)| {
            // Only the chosen tab is filled: glass draws every control's fill
            // nearly as bright as the selection.
            control(format!("repo-icon-mode-{key}"), label, enabled)
                .bg(if picker.mode == mode {
                    theme().selection
                } else {
                    crate::theme::CLEAR
                })
                .on_click(cx.listener(move |this, _, _, cx| this.icon_set(cx, |p| p.mode = mode)))
        })
        .collect::<Vec<_>>();
        let colors = matches!(picker.mode, Mode::Glyph | Mode::Monogram).then(|| {
            div()
                .mb(px(10.))
                .child(
                    div()
                        .mb(px(6.))
                        .text_color(theme().text_muted)
                        .child("Color"),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(4.))
                        .children(icons::COLORS.iter().map(|(color, _)| {
                            let color = *color;
                            div()
                                .id(ElementId::Name(format!("repo-icon-color-{color}").into()))
                                .debug_selector(move || format!("repo-icon-color-{color}"))
                                .size(px(24.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .border_1()
                                .border_color(if picker.color == color {
                                    theme().text
                                } else {
                                    gpui::transparent_black().into()
                                })
                                .cursor_pointer()
                                .child(
                                    div()
                                        .size(px(16.))
                                        .rounded_full()
                                        .bg(crate::theme::project_icon_color(color, true)
                                            .unwrap_or(theme().accent)),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.icon_set(cx, |p| p.color = color)
                                }))
                        })),
                )
        });
        let cell = |selector: String, selected: bool| {
            div()
                .id(ElementId::Name(selector.clone().into()))
                .debug_selector(move || selector.clone())
                .size(px(34.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .border_1()
                .border_color(if selected {
                    theme().border
                } else {
                    gpui::transparent_black().into()
                })
                .when(selected, |v| v.bg(theme().hover))
                .hover(|v| v.bg(theme().hover))
                .cursor_pointer()
        };
        let body = match picker.mode {
            Mode::Glyph => {
                let query = self
                    .icon_search
                    .read(cx)
                    .text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join("-")
                    .to_lowercase();
                let glyphs: Vec<_> = icons::GLYPHS
                    .iter()
                    .filter(|(name, _)| name.contains(&query))
                    .collect();
                div()
                    .child(field(
                        "repo-icon-search",
                        "Search icons",
                        self.icon_search.clone(),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(2.))
                            .children(glyphs.iter().map(|(name, _)| {
                                let name = *name;
                                cell(format!("repo-icon-glyph-{name}"), picker.glyph == name)
                                    .children(icons::glyph(name, picker.color, 18.))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.icon_set(cx, |p| p.glyph = name.into())
                                    }))
                            })),
                    )
                    .when(glyphs.is_empty(), |v| {
                        v.child(
                            div()
                                .py(px(16.))
                                .text_color(theme().text_muted)
                                .child("No icons found."),
                        )
                    })
            }
            Mode::Emoji => div()
                .child(div().flex().flex_wrap().gap(px(2.)).children(
                    icons::EMOJIS.iter().enumerate().map(|(index, (emoji, _))| {
                        let emoji = *emoji;
                        cell(format!("repo-icon-emoji-{index}"), picker.emoji == emoji)
                            .child(icons::emoji(emoji, 20.))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.icon_set(cx, |p| p.emoji = emoji.into())
                            }))
                    }),
                ))
                .child(div().mt(px(10.)).child(field(
                    "repo-icon-custom-emoji",
                    "Or paste any emoji",
                    self.icon_emoji.clone(),
                ))),
            Mode::Monogram => {
                let letters = icons::monogram(&self.icon_letters.read(cx).text);
                let shown = letters
                    .clone()
                    .unwrap_or_else(|| icons::derive(&picker.name).0);
                div()
                    .flex()
                    .gap(px(14.))
                    .items_center()
                    .child(
                        icons::tile(&shown, picker.color, 48.)
                            .debug_selector(move || format!("repo-icon-preview:{shown}")),
                    )
                    .child(
                        div()
                            .flex_1()
                            .child(field(
                                "repo-icon-letters",
                                "Letters",
                                self.icon_letters.clone(),
                            ))
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(if letters.is_some() {
                                        theme().text_muted
                                    } else {
                                        theme().warning
                                    })
                                    .child("One or two letters or numbers."),
                            ),
                    )
            }
            Mode::Image => div()
                .child(field(
                    "repo-icon-path",
                    "Image path in this repository",
                    self.icon_path.clone(),
                ))
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child("An image file inside the repository, up to 1 MiB."),
                ),
        };
        let save = patch.clone();
        let save_repo = repo.clone();
        Some(
            div()
                .debug_selector(|| "repo-icon-picker".into())
                .mt(px(4.))
                .mb(px(10.))
                .p(px(12.))
                .rounded(px(10.))
                .border_1()
                .border_color(theme().border)
                .bg(theme().surface)
                .child(div().text_size(px(14.)).child("Choose project icon"))
                .child(
                    div()
                        .mb(px(10.))
                        .text_color(theme().text_muted)
                        .child("Choose an icon, emoji, monogram, or an image in this repository."),
                )
                .child(div().flex().gap(px(6.)).mb(px(10.)).children(tabs))
                .children(colors)
                .child(body)
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .mt(px(12.))
                        .child(
                            control("repo-icon-save", "Save icon", enabled && save.is_some())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(patch) = save.clone() {
                                        this.act(Action::Icon(save_repo.clone(), patch), cx);
                                    }
                                })),
                        )
                        .child(
                            control("repo-icon-automatic", "Use automatic", enabled).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    let patch = json!({"projectIcon": null, "faviconPath": null});
                                    this.act(Action::Icon(repo.clone(), patch), cx);
                                }),
                            ),
                        )
                        .child(control("repo-icon-cancel", "Cancel", enabled).on_click(
                            cx.listener(move |this, _, _, cx| {
                                if enabled {
                                    this.icon = None;
                                    cx.notify();
                                }
                            }),
                        )),
                )
                .into_any_element(),
        )
    }
}
