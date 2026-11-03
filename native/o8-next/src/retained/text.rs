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
        } else if run.style.starts_with("link") {
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

/// A link's target, for runs that carry one.
pub(super) fn link_target(run: &Run) -> Option<&str> {
    run.style.strip_prefix("link:")
}

/// Issues and pull requests read as pills, like the trace's chips.
pub(super) fn is_item(url: &str) -> bool {
    url.starts_with('#')
        || url.starts_with("file:")
        || url.contains("/issues/")
        || url.contains("/pull/")
}
