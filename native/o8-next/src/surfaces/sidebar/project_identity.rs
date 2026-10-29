//! Same local identity and glyphs as the desktop ProjectIdentity component.
use crate::theme::current as theme;
use gpui::{prelude::*, *};
use std::sync::{Arc, OnceLock};

pub(super) fn identity(name: &str, color: Option<&str>, size: f32, selector: &str) -> Div {
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
            |view| {
                static LOGO: OnceLock<Arc<Image>> = OnceLock::new();
                let logo = LOGO.get_or_init(|| {
                    Arc::new(Image::from_bytes(
                        ImageFormat::Png,
                        include_bytes!("project_identity.png").to_vec(),
                    ))
                });
                view.child(
                    img(logo.clone())
                        .size(px(size))
                        .object_fit(ObjectFit::Contain),
                )
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
