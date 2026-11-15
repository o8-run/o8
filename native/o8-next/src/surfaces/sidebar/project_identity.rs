//! Same local identity and glyphs as the desktop ProjectIdentity component.
use crate::theme::current as theme;
use gpui::{prelude::*, *};

pub(crate) fn identity(name: &str, color: Option<&str>, size: f32, selector: &str) -> Div {
    let lower = name.to_lowercase();
    let brand = lower == "o8"
        || lower.strip_prefix("o8").is_some_and(|tail| {
            tail.starts_with('-') || tail.chars().next().is_some_and(char::is_whitespace)
        });
    let monogram: String = name
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|s| !s.is_empty())
        .take(2)
        .filter_map(|word| word.chars().next())
        .flat_map(char::to_uppercase)
        .collect();
    let monogram = if monogram.is_empty() {
        "P".into()
    } else {
        monogram
    };
    let marker = if brand {
        format!("{selector}:o8")
    } else {
        format!(
            "{selector}:{monogram}{}",
            color.map(|c| format!(":{c}")).unwrap_or_default()
        )
    };
    let ink: Hsla = color
        .and_then(|c| c.strip_prefix('#'))
        .and_then(|c| u32::from_str_radix(c, 16).ok())
        .map(|c| rgb(c).into())
        .unwrap_or(theme().accent.into());
    div()
        .debug_selector(move || marker.clone())
        .size(px(size))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .when_else(
            brand,
            // o8's own projects show the app's mark; a project's own icon
            // already won in `repo_identity`.
            |view| {
                let app = format!("{selector}:o8:app-mark");
                view.child(crate::ring::app_mark(size).debug_selector(move || app.clone()))
            },
            |view| {
                view.rounded(px(size * 0.25))
                    .bg(ink.opacity(0.16))
                    .text_color(ink)
                    .font_weight(FontWeight::LIGHT)
                    .text_size(px(size * 0.43))
                    .line_height(px(size))
                    .child(monogram)
            },
        )
}

pub(super) fn glyph(add: bool, size: f32, color: Rgba) -> impl IntoElement {
    // Paths are the existing desktop ProjectGlyph artwork, embedded for native use.
    let path = if add {
        "M3 8V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z M12 10v7m-3-3.5h6"
    } else {
        "m8 10 4 4 4-4"
    };
    crate::icon::stroke(path, color, size, 1.7)
}

#[cfg(test)]
mod tests {
    use super::super::repo_identity;
    use crate::project_icon::Icon;
    use gpui::{Context, TestAppContext, Window, div, prelude::*};

    struct Identities;
    impl Render for Identities {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let emoji = Icon::Emoji {
                emoji: "🚀".into()
            };
            div()
                .flex()
                .child(repo_identity("o8", None, None, 20., "default"))
                .child(repo_identity("o8-site", None, None, 14., "suffix"))
                .child(repo_identity("o8", None, Some(&emoji), 20., "custom"))
                .child(repo_identity("other", None, None, 20., "plain"))
        }
    }

    #[gpui::test]
    fn default_identity_is_the_app_mark_and_a_custom_icon_wins(cx: &mut TestAppContext) {
        let (_, cx) = cx.add_window_view(|_, _| Identities);
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        // o8's projects show the app's mark at the identity's own size.
        for (selector, size) in [("default", 20.), ("suffix", 14.)] {
            let mark = cx
                .debug_bounds(Box::leak(
                    format!("{selector}:o8:app-mark").into_boxed_str(),
                ))
                .unwrap_or_else(|| panic!("{selector} app mark"));
            assert_eq!(mark.size, gpui::size(gpui::px(size), gpui::px(size)));
            assert!(
                cx.debug_bounds(Box::leak(format!("{selector}:o8").into_boxed_str()))
                    .is_some()
            );
        }
        // A project's own icon still wins over the default.
        assert!(cx.debug_bounds("custom:emoji:🚀").is_some());
        assert!(cx.debug_bounds("custom:o8").is_none());
        assert!(cx.debug_bounds("custom:o8:app-mark").is_none());
        // Other projects keep their monogram.
        assert!(cx.debug_bounds("plain:O").is_some());
        assert!(cx.debug_bounds("plain:o8:app-mark").is_none());
    }
}
