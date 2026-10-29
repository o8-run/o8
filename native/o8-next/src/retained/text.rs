use crate::{text::Run, theme::current as theme};
use gpui::{TextRun, font, px};

pub(super) fn text_run(run: &Run) -> TextRun {
    let mut face = font(if run.style == "code" || run.style.starts_with("diff-") {
        theme().font_mono
    } else {
        theme().font_ui
    });
    face.weight = if run.style == "strong" {
        gpui::FontWeight::MEDIUM
    } else {
        gpui::FontWeight::LIGHT
    };
    if run.style == "em" {
        face.style = gpui::FontStyle::Italic;
    }
    TextRun {
        len: run.text.len(),
        font: face,
        color: (if run.style == "diff-add" {
            theme().success
        } else if run.style == "diff-remove" {
            theme().danger
        } else if run.style == "link" {
            theme().accent
        } else if run.style == "muted" {
            theme().text_muted
        } else {
            theme().text
        })
        .into(),
        background_color: if run.style == "code" {
            Some(theme().surface.into())
        } else {
            None
        },
        underline: None,
        strikethrough: if run.style == "strike" {
            Some(gpui::StrikethroughStyle {
                thickness: px(1.),
                color: None,
            })
        } else {
            None
        },
    }
}
