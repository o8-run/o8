//! VS Code color themes mapped onto theme.rs tokens. A theme file is JSON with
//! comments and trailing commas; its `colors` and `tokenColors` fill the
//! tokens they name, and every other token derives from a mapped color or
//! keeps the light or dark token set the theme's `type` picks.
use crate::theme::{Appearance, ImportedTheme, Theme};
use gpui::Rgba;
use serde_json::{Map, Value};
use std::path::Path;

/// Workbench color keys per token, first present wins.
const BACKGROUND: &[&str] = &["editor.background"];
const SURFACE: &[&str] = &["sideBar.background", "activityBar.background"];
const SURFACE_RAISED: &[&str] = &[
    "editorWidget.background",
    "dropdown.background",
    "input.background",
];
const TEXT: &[&str] = &["editor.foreground", "foreground", "activityBar.foreground"];
const TEXT_SECONDARY: &[&str] = &["descriptionForeground"];
const TEXT_MUTED: &[&str] = &["input.placeholderForeground"];
const TEXT_FAINT: &[&str] = &["editorLineNumber.foreground"];
const BORDER: &[&str] = &[
    "sideBar.border",
    "panel.border",
    "input.border",
    "contrastBorder",
];
const HOVER: &[&str] = &["list.hoverBackground"];
const ACCENT: &[&str] = &[
    "focusBorder",
    "button.background",
    "activityBar.activeBorder",
    "statusBar.background",
];
const DANGER: &[&str] = &["errorForeground", "editorError.foreground"];
const SUCCESS: &[&str] = &[
    "gitDecoration.addedResourceForeground",
    "terminal.ansiGreen",
];
const WARNING: &[&str] = &["editorWarning.foreground", "list.warningForeground"];
const SELECTION: &[&str] = &[
    "list.activeSelectionBackground",
    "editor.selectionBackground",
];
const CODE_BACKGROUND: &[&str] = &["textCodeBlock.background"];
const CURSOR: &[&str] = &["terminalCursor.foreground", "editorCursor.foreground"];
/// TextMate scopes per syntax token, matching how diff.rs colors tree nodes:
/// strings; headings and links; numbers, emphasis and code spans; keywords
/// and types.
const STRING: &[&str] = &["string"];
const LINK: &[&str] = &["markup.underline.link", "markup.heading"];
const EMPHASIS: &[&str] = &["constant.numeric", "markup.italic", "markup.inline.raw"];
const KEYWORD: &[&str] = &["keyword", "storage", "entity.name.type"];

/// Parses a VS Code color theme. `fallback_name` names a theme without a
/// `name`, such as by its file name.
pub(crate) fn parse(source: &str, fallback_name: &str) -> Result<ImportedTheme, String> {
    let value: Value = serde_json::from_str(&strip_jsonc(source))
        .map_err(|error| format!("This is not a JSON theme file: {error}."))?;
    let Some(object) = value.as_object() else {
        return Err("This is not a VS Code color theme: it is not a JSON object.".into());
    };
    let empty = Map::new();
    let colors = object
        .get("colors")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let scopes = token_colors(object.get("tokenColors"));
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback_name)
        .to_string();
    let id = slug(&name);
    if id.is_empty() {
        return Err("This theme has no name.".into());
    }
    let color = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| colors.get(*key).and_then(Value::as_str).and_then(hex))
    };
    let scope = |targets: &[&str]| {
        targets
            .iter()
            .find_map(|target| scope_color(&scopes, target))
    };
    let background = color(BACKGROUND);
    let base = match object.get("type").and_then(Value::as_str) {
        Some("light" | "hcLight") => Appearance::Light,
        Some(_) => Appearance::Dark,
        None if background.is_some_and(|color| luminance(color) > 0.5) => Appearance::Light,
        None => Appearance::Dark,
    };
    let mut theme = Theme::for_appearance(base);
    let mut mapped = 0;
    let mut set = |token: &mut Rgba, value: Option<Rgba>| {
        if let Some(value) = value {
            *token = value;
            mapped += 1;
        }
    };
    // Mapped colors first, then shades derived from them the way theme.rs
    // derives its own: surfaces and washes are translucent mapped colors.
    let wash = if base == Appearance::Light {
        0.12
    } else {
        0.15
    };
    let text = color(TEXT);
    let accent = color(ACCENT);
    set(&mut theme.background, background);
    set(
        &mut theme.surface,
        color(SURFACE).or(background.map(|color| alpha(color, 0.82))),
    );
    set(
        &mut theme.surface_raised,
        color(SURFACE_RAISED).or(background),
    );
    set(
        &mut theme.code_background,
        color(CODE_BACKGROUND).or(background),
    );
    set(&mut theme.text, text);
    set(
        &mut theme.text_secondary,
        color(TEXT_SECONDARY).or(text.map(|color| alpha(color, 0.78))),
    );
    set(
        &mut theme.text_muted,
        color(TEXT_MUTED).or(text.map(|color| alpha(color, 0.66))),
    );
    set(
        &mut theme.text_faint,
        color(TEXT_FAINT).or(text.map(|color| alpha(color, 0.5))),
    );
    set(
        &mut theme.border,
        color(BORDER).or(text.map(|color| alpha(color, 0.08))),
    );
    set(
        &mut theme.hover,
        color(HOVER).or(text.map(|color| alpha(color, 0.06))),
    );
    set(&mut theme.accent, accent);
    set(
        &mut theme.selection,
        color(SELECTION).or(accent.map(|color| alpha(color, wash))),
    );
    set(
        &mut theme.terminal_cursor,
        color(CURSOR).or(accent).map(|color| alpha(color, 0.5)),
    );
    let danger = color(DANGER);
    let success = color(SUCCESS);
    set(&mut theme.danger, danger);
    set(&mut theme.success, success);
    set(&mut theme.warning, color(WARNING));
    set(
        &mut theme.danger_surface,
        danger.map(|color| alpha(color, wash)),
    );
    set(
        &mut theme.success_surface,
        success.map(|color| alpha(color, wash)),
    );
    set(&mut theme.syntax_string, scope(STRING));
    set(&mut theme.syntax_link, scope(LINK));
    set(&mut theme.syntax_emphasis, scope(EMPHASIS));
    set(&mut theme.syntax_keyword, scope(KEYWORD));
    if mapped == 0 {
        return Err("This is not a VS Code color theme: it has no colors o8 can use.".into());
    }
    Ok(ImportedTheme {
        id,
        name,
        base,
        theme,
    })
}

/// Saved themes: their ids and original sources, so a later mapping applies
/// to themes imported before it.
pub(crate) fn load(path: &Path) -> Vec<ImportedTheme> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(Value::Array(entries)) = serde_json::from_str(&text) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let source = entry["source"].as_str()?;
            let id = entry["id"].as_str()?;
            parse(source, id).ok()
        })
        .collect()
}

/// Adds a theme's source to the saved themes, replacing one with its id.
pub(crate) fn save(path: &Path, id: &str, source: &str) -> Result<(), String> {
    let mut entries = match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(Value::Array(entries)) => entries,
            _ => return Err(format!("{} is not a saved theme list.", path.display())),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Could not read saved themes: {error}.")),
    };
    entries.retain(|entry| entry["id"].as_str() != Some(id));
    entries.push(serde_json::json!({ "id": id, "source": source }));
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(&Value::Array(entries)).unwrap();
    // Written beside the store and renamed over it, so a crash mid-write
    // never leaves a truncated store behind.
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, text)
        .and_then(|()| std::fs::rename(&staged, path))
        .map_err(|error| format!("Could not save the theme: {error}."))
}

/// Comments become whitespace and a comma before `}` or `]` is dropped;
/// strings pass through untouched.
fn strip_jsonc(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push(c);
                while let Some(c) = chars.next() {
                    out.push(c);
                    if c == '\\' {
                        if let Some(escaped) = chars.next() {
                            out.push(escaped);
                        }
                    } else if c == '"' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'/') => while chars.next_if(|c| *c != '\n').is_some() {},
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = ' ';
                for c in chars.by_ref() {
                    if previous == '*' && c == '/' {
                        break;
                    }
                    if c == '\n' {
                        out.push('\n');
                    }
                    previous = c;
                }
                out.push(' ');
            }
            '}' | ']' => {
                let kept = out.trim_end().len();
                if out[..kept].ends_with(',') {
                    out.remove(kept - 1);
                }
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.
fn hex(value: &str) -> Option<Rgba> {
    let digits = value.trim().strip_prefix('#')?;
    if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let long: String = match digits.len() {
        3 | 4 => digits.chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => digits.into(),
        _ => return None,
    };
    let channel = |at: usize| {
        long.get(at..at + 2).map_or(Some(1.), |pair| {
            Some(f32::from(u8::from_str_radix(pair, 16).ok()?) / 255.)
        })
    };
    Some(Rgba {
        r: channel(0)?,
        g: channel(2)?,
        b: channel(4)?,
        a: channel(6)?,
    })
}

fn alpha(color: Rgba, a: f32) -> Rgba {
    Rgba {
        a: color.a * a,
        ..color
    }
}

fn luminance(color: Rgba) -> f32 {
    0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

/// Each tokenColors rule's scopes with its foreground, in file order.
fn token_colors(rules: Option<&Value>) -> Vec<(String, Rgba)> {
    let mut scopes = Vec::new();
    for rule in rules.and_then(Value::as_array).into_iter().flatten() {
        let Some(color) = rule["settings"]["foreground"].as_str().and_then(hex) else {
            continue;
        };
        let names: Vec<&str> = match &rule["scope"] {
            Value::String(names) => names.split(',').collect(),
            Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
            _ => continue,
        };
        for name in names {
            scopes.push((name.trim().to_string(), color));
        }
    }
    scopes
}

/// The rule for `target` itself, else the first rule for one of its
/// children, as a TextMate theme colors a general scope.
fn scope_color(scopes: &[(String, Rgba)], target: &str) -> Option<Rgba> {
    let child = format!("{target}.");
    scopes
        .iter()
        .rev()
        .find(|(scope, _)| scope == target)
        .or_else(|| scopes.iter().find(|(scope, _)| scope.starts_with(&child)))
        .map(|(_, color)| *color)
}

fn slug(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_end_matches('-').to_string()
}

#[cfg(test)]
#[path = "theme_import_tests.rs"]
mod tests;
