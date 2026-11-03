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

/// Where a file pill really points, shown before anyone clicks it.
pub(super) fn file_tip(root: Option<&str>, url: &str) -> Option<String> {
    let (path, line) = crate::text::file_ref(url.strip_prefix("file:")?)?;
    let at = line.map_or_else(String::new, |line| format!(":{line}"));
    Some(match root {
        Some(root) => format!("{}/{path}{at}", root.trim_end_matches('/')),
        None => format!("{path}{at}"),
    })
}
#[cfg(test)]
#[test]
fn a_pill_names_the_file_it_opens() {
    assert_eq!(
        file_tip(Some("/repo/"), "file:src/a.rs:12").as_deref(),
        Some("/repo/src/a.rs:12")
    );
    assert_eq!(file_tip(None, "file:a.rs").as_deref(), Some("a.rs"));
    assert_eq!(file_tip(Some("/repo"), "https://a.com"), None);
}

/// Issues and pull requests read as pills, like the trace's chips.
pub(super) fn is_item(url: &str) -> bool {
    url.starts_with('#')
        || url.starts_with("file:")
        || url.contains("/issues/")
        || url.contains("/pull/")
}
