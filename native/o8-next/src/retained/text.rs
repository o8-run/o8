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

/// Room before a pill's words for its icon. Nothing breaks a line between it
/// and the words, so the icon wraps with them.
pub(super) const ICON_ROOM: &str = "\u{2007}\u{2007}";

/// What a file or web pill reads as: room for its icon, then the file's name
/// and line, or the site. Copy still gives the text the reply wrote.
pub(super) fn pill_label(run: &Run) -> Option<String> {
    let url = link_target(run)?;
    if let Some(reference) = url.strip_prefix("file:") {
        let (path, line) = crate::text::file_ref(reference)?;
        let name = path.rsplit('/').next().unwrap_or(path);
        let at = line.map_or_else(String::new, |line| format!(":{line}"));
        return Some(format!("{ICON_ROOM}{name}{at}"));
    }
    (run.text == url)
        .then(|| web_host(url))
        .flatten()
        .map(|host| format!("{ICON_ROOM}{host}"))
}
fn web_host(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty()).then_some(host)
}
/// What hovering a link says: the file a pill opens, or a web link's address.
pub(super) fn link_tip(root: Option<&str>, url: &str) -> Option<String> {
    file_tip(root, url).or_else(|| web_host(url).map(|_| url.to_owned()))
}
#[cfg(test)]
#[test]
fn pills_read_as_a_file_name_or_a_site() {
    let label = |style: &str, text: &str| {
        pill_label(&Run {
            style: style.into(),
            text: text.into(),
        })
    };
    let room = |text: &str| Some(format!("{ICON_ROOM}{text}"));
    assert_eq!(
        label("link:file:src/a/b.rs:12", "src/a/b.rs:12"),
        room("b.rs:12")
    );
    assert_eq!(
        label("link:file:src/a.ts#L5", "src/a.ts#L5"),
        room("a.ts:5")
    );
    assert_eq!(
        label("link:file:package.json", "package.json"),
        room("package.json")
    );
    let url = "https://www.example.com/a/b?c=1";
    assert_eq!(label(&format!("link:{url}"), url), room("example.com"));
    let url = "http://user@x.dev:8080#top";
    assert_eq!(label(&format!("link:{url}"), url), room("x.dev:8080"));
    // A link with its own words, an issue and plain code keep what they say.
    assert_eq!(label("link:https://example.com/a", "the bug"), None);
    assert_eq!(label("link:#5244", "#5244"), None);
    assert_eq!(label("code", "src/a.rs"), None);
    assert_eq!(
        link_tip(None, "https://example.com/a").as_deref(),
        Some("https://example.com/a")
    );
    assert_eq!(
        link_tip(Some("/r"), "file:a.rs:2").as_deref(),
        Some("/r/a.rs:2")
    );
    assert_eq!(link_tip(None, "#5244"), None);
}

/// Issues and pull requests read as pills, like the trace's chips.
pub(super) fn is_item(url: &str) -> bool {
    url.starts_with('#')
        || url.starts_with("file:")
        || url.contains("/issues/")
        || url.contains("/pull/")
}
