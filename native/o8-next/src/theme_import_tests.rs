//! VS Code theme import receipts over the checked-in fixture themes.
use super::*;
use crate::theme::{self, Appearance, Theme};

const DARK: &str = include_str!("../fixtures/themes/vscode-dark.json");
const LIGHT_JSONC: &str = include_str!("../fixtures/themes/vscode-light-jsonc.json");
const MALFORMED: &str = include_str!("../fixtures/themes/vscode-malformed.json");

fn color(hex: u32) -> Rgba {
    gpui::rgb(hex)
}
fn with_alpha(hex: u32, a: f32) -> Rgba {
    Rgba { a, ..color(hex) }
}
fn same(a: Rgba, b: Rgba) -> bool {
    [a.r - b.r, a.g - b.g, a.b - b.b, a.a - b.a]
        .iter()
        .all(|delta| delta.abs() < 0.002)
}
#[track_caller]
fn assert_color(actual: Rgba, expected: Rgba, token: &str) {
    assert!(
        same(actual, expected),
        "{token}: {actual:?} != {expected:?}"
    );
}

#[test]
fn a_vscode_theme_maps_its_colors_and_token_scopes_onto_the_tokens() {
    let imported = parse(DARK, "fallback").unwrap();
    assert_eq!(imported.id, "harbor-night");
    assert_eq!(imported.name, "Harbor Night");
    assert_eq!(imported.base, Appearance::Dark);
    let t = &imported.theme;
    for (actual, expected, token) in [
        (t.background, color(0x1e2129), "background"),
        (t.surface, color(0x191c23), "surface"),
        (t.surface_raised, color(0x252933), "surface_raised"),
        (t.code_background, color(0x1e2129), "code_background"),
        (t.text, color(0xd4d7de), "text"),
        (
            t.text_secondary,
            with_alpha(0xd4d7de, 0.78),
            "text_secondary",
        ),
        (t.text_muted, color(0x7c8290), "text_muted"),
        (t.text_faint, color(0x596070), "text_faint"),
        (t.border, color(0x323745), "border"),
        (t.hover, color(0x2a2e38), "hover"),
        (t.accent, color(0x4c8df6), "accent"),
        (t.selection, with_alpha(0x2f6fd6, 64. / 255.), "selection"),
        (t.danger, color(0xf06a6a), "danger"),
        (t.success, color(0x6cc287), "success"),
        (t.warning, color(0xe0b450), "warning"),
        (
            t.danger_surface,
            with_alpha(0xf06a6a, 0.15),
            "danger_surface",
        ),
        (
            t.success_surface,
            with_alpha(0x6cc287, 0.15),
            "success_surface",
        ),
        (
            t.terminal_cursor,
            with_alpha(0x4c8df6, 0.5),
            "terminal_cursor",
        ),
        (t.syntax_string, color(0xa6d08a), "syntax_string"),
        (t.syntax_keyword, color(0xc792ea), "syntax_keyword"),
        (t.syntax_emphasis, color(0xf2a65a), "syntax_emphasis"),
        (t.syntax_link, color(0x82aaff), "syntax_link"),
    ] {
        assert_color(actual, expected, token);
    }
    let base = Theme::for_appearance(Appearance::Dark);
    assert_eq!(t.terminal_ansi, base.terminal_ansi);
    assert_eq!((t.font_ui, t.font_mono), (base.font_ui, base.font_mono));
}

#[test]
fn comments_and_trailing_commas_parse_and_unmapped_tokens_keep_the_typed_base() {
    let imported = parse(LIGHT_JSONC, "fallback").unwrap();
    assert_eq!(imported.name, "Paper // Morning");
    assert_eq!(imported.id, "paper-morning");
    assert_eq!(imported.base, Appearance::Light);
    let t = &imported.theme;
    assert_color(t.background, color(0xfbfaf7), "background");
    assert_color(t.surface, color(0xf1efe9), "surface");
    assert_color(t.accent, color(0x0b66c3), "accent");
    assert_color(t.selection, with_alpha(0x0b66c3, 0.12), "selection");
    assert_color(t.syntax_string, color(0x2f7d32), "syntax_string");
    assert_color(t.syntax_keyword, color(0x8e3fbf), "syntax_keyword");
    let light = Theme::for_appearance(Appearance::Light);
    for (actual, expected, token) in [
        (t.danger, light.danger, "danger"),
        (t.warning, light.warning, "warning"),
        (t.syntax_link, light.syntax_link, "syntax_link"),
    ] {
        assert_color(actual, expected, token);
    }
    // Without a type, a light editor background picks the light base.
    let untyped = parse(
        r##"{"colors": {"editor.background": "#fafafa",},}"##,
        "Untyped",
    )
    .unwrap();
    assert_eq!(
        (untyped.base, untyped.id.as_str()),
        (Appearance::Light, "untyped")
    );
}

#[test]
fn malformed_and_colorless_files_are_refused_with_a_reason() {
    let error = parse(MALFORMED, "broken").err().unwrap();
    assert!(error.contains("not a JSON theme file"), "{error}");
    for (source, reason) in [
        ("[]", "not a JSON object"),
        (
            r#"{"name": "Empty", "colors": {"editor.background": "blue"}}"#,
            "no colors",
        ),
        (
            r##"{"name": "  ", "colors": {"editor.background": "#000"}}"##,
            "no name",
        ),
    ] {
        let error = parse(source, "").err().unwrap();
        assert!(error.contains(reason), "{source}: {error}");
    }
}

#[test]
fn saved_themes_round_trip_through_the_store_and_replace_by_id() {
    let path = crate::shell::test_support::scratch_path("o8-next-themes").join("next-themes.json");
    save(&path, "harbor-night", MALFORMED).unwrap();
    save(&path, "paper-morning", LIGHT_JSONC).unwrap();
    save(&path, "harbor-night", DARK).unwrap();
    let loaded = load(&path);
    assert_eq!(
        loaded.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["paper-morning", "harbor-night"]
    );
    let fresh = parse(DARK, "").unwrap();
    assert_color(
        loaded[1].theme.background,
        fresh.theme.background,
        "background",
    );
    assert_color(
        loaded[1].theme.syntax_keyword,
        fresh.theme.syntax_keyword,
        "keyword",
    );
    assert_eq!(loaded[0].base, Appearance::Light);
    std::fs::write(&path, "not json").unwrap();
    assert!(load(&path).is_empty());
    assert!(
        save(&path, "x", DARK).is_err(),
        "a corrupt store is not overwritten"
    );
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn selecting_an_imported_theme_applies_it_to_the_live_theme_handle() {
    let _guard = theme::selection_test_guard();
    let previous = theme::choice_name();
    let before = theme::imported_themes();
    assert!(theme::import_theme(MALFORMED, "broken").is_err());
    assert_eq!(
        theme::imported_themes(),
        before,
        "a bad file changes nothing"
    );
    let name = theme::import_theme(DARK, "harbor").unwrap();
    assert_eq!(name, "theme:harbor-night");
    assert!(theme::imported_themes().contains(&(name.clone(), "Harbor Night".into())));
    let generation = theme::generation();
    assert!(theme::set_appearance(&name));
    assert_ne!(theme::generation(), generation, "painted caches refresh");
    assert_eq!(theme::choice_name(), name);
    assert_eq!(theme::appearance_name(), "dark");
    assert_color(
        theme::current().background,
        color(0x1e2129),
        "live background",
    );
    assert_color(
        theme::plain_background(),
        color(0x1e2129),
        "window background",
    );
    assert!(theme::set_appearance("system"));
    theme::set_system_light(true);
    assert_eq!(theme::appearance_name(), "light");
    theme::set_system_light(false);
    assert_eq!(theme::appearance_name(), "dark");
    theme::set_appearance(&previous);
    assert_eq!(theme::choice_name(), previous);
}
