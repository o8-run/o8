//! The dock's file drop target and staged-file chips, drawn natively behind the
//! `native_dictation_pill` flag. Neither takes clicks: the drag and drop are
//! still received and staged by the web dock (agent_files_stage), which keeps
//! its own window under the panel; this module only draws.
use super::Pill;
use gpui::{AnyElement, div, prelude::*, px};
use serde::Deserialize;

/// DockNotchSurface's footprints for the drop target and the staged chips.
pub(crate) const DROP: (f64, f64) = (320., 64.);
pub(crate) const STAGED: (f64, f64) = (420., 56.);

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Staged {
    /// At most three files, each with the web's size label.
    #[serde(default)]
    pub files: Vec<StagedFile>,
    /// How many more files the `+N` chip counts.
    #[serde(default)]
    pub extra: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StagedFile {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub size: String,
}

impl Staged {
    pub(crate) fn valid(&self) -> bool {
        !self.files.is_empty()
    }
}

impl Pill {
    pub(crate) fn render_drop(&self, opacity: f32) -> AnyElement {
        let t = crate::theme::current();
        let staged = self.snapshot.state == "staged";
        let (width, height) = if staged { STAGED } else { DROP };
        let surface = div()
            .debug_selector(move || {
                if staged {
                    "native-dock-staged".into()
                } else {
                    "native-dock-drop".into()
                }
            })
            .w(px(width as f32))
            .h(px(height as f32))
            .rounded(px(if staged { 22. } else { 24. }))
            .overflow_hidden()
            .bg(t.surface_raised)
            .border_1()
            // The drop target's receiving ring (the web's inset accent ring).
            .border_color(if staged { t.border } else { t.accent })
            .font_family(t.font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .opacity(opacity)
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(if staged { 4. } else { 3. }));
        let caption = |text: &'static str| {
            div()
                .text_size(px(9.5))
                .text_color(t.text_secondary)
                .whitespace_nowrap()
                .child(text)
        };
        if !staged {
            return surface
                .child(
                    div()
                        .text_size(px(12.5))
                        .text_color(t.text)
                        .whitespace_nowrap()
                        .child("Drop files for Symon"),
                )
                .child(caption("THEY RIDE YOUR NEXT QUESTION"))
                .into_any_element();
        }
        let files = self.snapshot.staged.clone().unwrap_or_default();
        let chip = || {
            div()
                .flex()
                .items_center()
                .h(px(22.))
                .px(px(9.))
                .rounded(px(11.))
                .bg(t.hover)
                .border_1()
                .border_color(t.border)
                .text_size(px(10.5))
                .whitespace_nowrap()
                .overflow_hidden()
        };
        let mut row = div().flex().gap(px(6.)).max_w_full().overflow_hidden();
        for file in &files.files {
            row = row.child(
                chip()
                    .max_w(px(150.))
                    .text_color(t.text)
                    .child(div().truncate().child(file.name.clone()))
                    .child(
                        div()
                            .flex_shrink_0()
                            .ml(px(4.))
                            .text_color(t.text_secondary)
                            .child(file.size.clone()),
                    ),
            );
        }
        if files.extra > 0 {
            row = row.child(
                chip()
                    .px(px(8.))
                    .text_color(t.text_secondary)
                    .child(format!("+{}", files.extra)),
            );
        }
        surface
            .px(px(16.))
            .child(row)
            .child(caption("STAGED — HOLD ⌥ AND ASK"))
            .into_any_element()
    }
}
