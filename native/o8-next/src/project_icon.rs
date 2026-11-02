//! Repository icon overrides from the repository listing (`icon` on GET
//! /api/panel/repos), drawn wherever a repository's identity shows, and the
//! choices the Projects page's icon picker offers.
//!
//! Adapted from T3 Code (https://github.com/pingdotgg/t3code),
//! apps/web/src/projectIconOptions.ts, apps/web/src/projectIconColors.ts,
//! apps/web/src/projectIdentity.ts and apps/web/src/components/ProjectFavicon.tsx,
//! commit f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools
//! Inc. MIT; full notice retained in licenses/t3code-MIT.txt.
//! Glyph artwork from Lucide (lucide-react 0.577.0, ISC; see NOTICE.md).
//! Adaptations: Rust and GPUI; native draws T3's 24 popular glyphs, and any
//! other glyph name as the derived monogram in its color.
use crate::theme::current as theme;
use gpui::{prelude::*, *};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

/// The listing's icon: an identity override, or an image the server found or
/// was given. Identity overrides win over images on the server.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Icon {
    Monogram { text: String, color: String },
    Emoji { emoji: String },
    Glyph { name: String, color: String },
    Image { path: String },
}

/// A host without icons sends none; an unknown or malformed icon also leaves
/// the repository's monogram rather than failing the listing.
pub(crate) fn lenient<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Icon>, D::Error> {
    Ok(Option::<Value>::deserialize(d)?.and_then(|v| serde_json::from_value(v).ok()))
}

pub(crate) const COLORS: [(&str, &str); 18] = [
    ("gray", "Gray"),
    ("red", "Red"),
    ("orange", "Orange"),
    ("amber", "Amber"),
    ("yellow", "Yellow"),
    ("lime", "Lime"),
    ("green", "Green"),
    ("emerald", "Emerald"),
    ("teal", "Teal"),
    ("cyan", "Cyan"),
    ("sky", "Sky"),
    ("blue", "Blue"),
    ("indigo", "Indigo"),
    ("violet", "Violet"),
    ("purple", "Purple"),
    ("fuchsia", "Fuchsia"),
    ("pink", "Pink"),
    ("rose", "Rose"),
];

/// T3's popular project glyphs, by their Lucide names, as one path each.
pub(crate) const GLYPHS: [(&str, &str); 24] = [
    (
        "folder-code",
        "M10 10.5 8 13l2 2.5 M14 10.5l2 2.5-2 2.5 M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z",
    ),
    ("code-2", "M18 16l4-4-4-4 M6 8l-4 4 4 4 M14.5 4l-5 16"),
    ("terminal", "M12 19h8 M4 17l6-6-6-6"),
    (
        "globe-2",
        "M21.54 15H17a2 2 0 0 0-2 2v4.54 M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17 M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05 M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
    ),
    (
        "server",
        "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2Z M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2Z M6 6L6.01 6 M6 18L6.01 18",
    ),
    (
        "database",
        "M3 5a9 3 0 1 0 18 0a9 3 0 1 0 -18 0 M3 5V19A9 3 0 0 0 21 19V5 M3 12A9 3 0 0 0 21 12",
    ),
    (
        "bot",
        "M12 8V4H8 M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2Z M2 14h2 M20 14h2 M15 13v2 M9 13v2",
    ),
    (
        "sparkles",
        "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z M20 2v4 M22 4h-4 M2 20a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    ),
    (
        "smartphone",
        "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-16a2 2 0 0 1 2 -2Z M12 18h.01",
    ),
    (
        "monitor",
        "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2Z M8 21L16 21 M12 17L12 21",
    ),
    (
        "cloud-cog",
        "M10.852 19.772l-.383.924 M13.148 14.228l.383-.923 M13.148 19.772a3 3 0 1 0-2.296-5.544l-.383-.923 M13.53 20.696l-.382-.924a3 3 0 1 1-2.296-5.544 M14.772 15.852l.923-.383 M14.772 18.148l.923.383 M4.2 15.1a7 7 0 1 1 9.93-9.858A7 7 0 0 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2 M9.228 15.852l-.923-.383 M9.228 18.148l-.923.383",
    ),
    (
        "package",
        "M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z M12 22V12 M3.29 7L12 12L20.71 7 M7.5 4.27l9 5.15",
    ),
    (
        "book-open",
        "M12 7v14 M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
    ),
    (
        "flask-conical",
        "M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2 M6.453 15h11.094 M8.5 2h7",
    ),
    (
        "shield-check",
        "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z M9 12l2 2 4-4",
    ),
    (
        "rocket",
        "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5 M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09 M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05",
    ),
    (
        "gamepad-2",
        "M6 11L10 11 M8 9L8 13 M15 12L15.01 12 M18 10L18.01 10 M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z",
    ),
    (
        "music",
        "M9 18V5l12-2v13 M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M15 16a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
    ),
    (
        "image",
        "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2Z M7 9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
    ),
    (
        "shopping-bag",
        "M16 10a4 4 0 0 1-8 0 M3.103 6.034h17.794 M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z",
    ),
    (
        "git-branch",
        "M15 6a9 9 0 0 0-9 9V3 M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
    ),
    (
        "workflow",
        "M5 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-4a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2Z M7 11v4a2 2 0 0 0 2 2h4 M15 13h4a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-4a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2Z",
    ),
    (
        "wrench",
        "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z",
    ),
    (
        "layers-3",
        "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12 M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17",
    ),
];

pub(crate) const EMOJIS: [(&str, &str); 30] = [
    ("💻", "Computer"),
    ("🛠️", "Tools"),
    ("🚀", "Rocket"),
    ("🤖", "Robot"),
    ("✨", "Sparkles"),
    ("⚡", "Lightning"),
    ("🌐", "Web"),
    ("📱", "Mobile"),
    ("🖥️", "Desktop"),
    ("⌨️", "Keyboard"),
    ("⚙️", "Gear"),
    ("🗄️", "Database"),
    ("☁️", "Cloud"),
    ("📦", "Package"),
    ("📚", "Books"),
    ("🧪", "Test tube"),
    ("🔒", "Lock"),
    ("🎮", "Game"),
    ("🎵", "Music"),
    ("🎬", "Movie"),
    ("🖼️", "Picture"),
    ("🛍️", "Shopping"),
    ("🔥", "Fire"),
    ("💡", "Idea"),
    ("🧩", "Puzzle"),
    ("📊", "Chart"),
    ("🧠", "Brain"),
    ("🦄", "Unicorn"),
    ("🐙", "Octopus"),
    ("🌱", "Seedling"),
];

/// The glyph the picker starts on, as in T3.
pub(crate) const DEFAULT_GLYPH: &str = "folder-code";

/// T3's automatic identity for a name: two monogram letters and a color.
pub(crate) fn derive(name: &str) -> (String, &'static str) {
    let name = name.trim();
    let words: Vec<&str> = name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let monogram = match words.first() {
        None => "PR".to_owned(),
        Some(first) => {
            let glyphs: Vec<char> = first.chars().collect();
            let second = glyphs[1..]
                .iter()
                .copied()
                .find(|c| c.is_numeric())
                .or_else(|| {
                    if words.len() > 1 {
                        words.last().and_then(|w| w.chars().next())
                    } else {
                        glyphs.last().copied()
                    }
                })
                .unwrap_or(glyphs[0]);
            [glyphs[0], second]
                .iter()
                .flat_map(|c| c.to_uppercase())
                .take(2)
                .collect()
        }
    };
    let seed = if name.is_empty() {
        "project".to_owned()
    } else {
        name.to_lowercase()
    };
    let index = seed
        .chars()
        .fold(0usize, |index, c| (index * 31 + c as usize) % COLORS.len());
    (monogram, COLORS[index].0)
}

/// Monogram letters as the server stores them when valid: one or two
/// letters or numbers, upper case. (The server also normalizes with NFKC.)
pub(crate) fn monogram(letters: &str) -> Option<String> {
    let text = letters.trim().to_uppercase();
    let count = text.graphemes(true).count();
    (text.chars().next().is_some_and(char::is_alphanumeric)
        && text
            .chars()
            .all(|c| c.is_alphanumeric() || c == '\u{200c}' || c == '\u{200d}')
        && (1..=2).contains(&count)
        && text.len() <= 32)
        .then_some(text)
}

/// The first emoji of pasted text, as T3's firstEmoji: a pictographic
/// grapheme, a flag or a keycap.
pub(crate) fn first_emoji(value: &str) -> Option<String> {
    let first = value.trim().graphemes(true).next()?;
    first
        .chars()
        .any(|c| {
            matches!(c as u32,
                0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2300..=0x23FF | 0x2B00..=0x2BFF
                | 0x20E3 | 0x3030 | 0x303D | 0x3297 | 0x3299 | 0xA9 | 0xAE | 0x203C
                | 0x2049 | 0x2122 | 0x2139 | 0x2194..=0x21AA)
        })
        .then(|| first.to_owned())
}

fn ink(color: &str) -> Rgba {
    crate::theme::project_icon_color(color, false).unwrap_or(theme().accent)
}

/// The identity tile: letters on a tint of their color.
pub(crate) fn tile(text: &str, color: &str, size: f32) -> Div {
    let ink: Hsla = ink(color).into();
    div()
        .size(px(size))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(size * 0.25))
        .bg(ink.opacity(0.16))
        .text_color(ink)
        .font_weight(FontWeight::LIGHT)
        .text_size(px(size * 0.43))
        .line_height(px(size))
        .child(text.to_owned())
}

/// A glyph by name in a color, or None when this build lacks it.
pub(crate) fn glyph(name: &str, color: &str, size: f32) -> Option<Div> {
    let (_, path) = GLYPHS.iter().find(|(glyph, _)| *glyph == name)?;
    Some(
        div()
            .size(px(size))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .child(crate::icon::stroke(path, ink(color), size, 2.)),
    )
}

pub(crate) fn emoji(emoji: &str, size: f32) -> Div {
    div()
        .size(px(size))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size * 0.8))
        .line_height(px(size))
        .child(emoji.to_owned())
}

/// A repository's override at `size`, marked `{selector}:{kind}:...`, or None
/// for the caller's own monogram: no override, or an image.
pub(crate) fn mark(
    name: &str,
    icon: Option<&Icon>,
    size: f32,
    selector: &str,
) -> Option<AnyElement> {
    let (marker, view) = match icon? {
        Icon::Monogram { text, color } => (
            format!("{selector}:monogram:{text}:{color}"),
            tile(text, color, size),
        ),
        Icon::Emoji { emoji: value } => (format!("{selector}:emoji:{value}"), emoji(value, size)),
        Icon::Glyph {
            name: glyph_name,
            color,
        } => match glyph(glyph_name, color, size) {
            Some(view) => (format!("{selector}:glyph:{glyph_name}:{color}"), view),
            None => {
                let (text, _) = derive(name);
                (
                    format!("{selector}:monogram:{text}:{color}"),
                    tile(&text, color, size),
                )
            }
        },
        // #5135: GET /api/panel/repo-icon is held for the security lane. Until
        // it lands an image shows the repository's monogram; fetch it here.
        Icon::Image { .. } => return None,
    };
    Some(
        view.debug_selector(move || marker.clone())
            .into_any_element(),
    )
}
