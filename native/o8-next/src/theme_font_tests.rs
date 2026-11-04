//! Font picker receipts: the picker model, the saved fonts and a missing family.
use crate::theme::{self, DEFAULT_FONTS, Fonts, current, font_options};

/// Font switches are process-wide; these tests hold one lock between them.
pub(crate) fn font_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
fn installed() -> Vec<String> {
    [
        "Zeta Sans",
        ".Private Face",
        "alpha Mono",
        "Iosevka",
        "Iosevka",
    ]
    .map(String::from)
    .to_vec()
}

#[test]
fn the_picker_lists_installed_families_with_the_default_first_and_marks_the_current_one() {
    let _guard = font_test_guard();
    let before = theme::fonts();
    theme::set_font(true, DEFAULT_FONTS.mono, &installed());
    let options = font_options(true, &installed());
    let families: Vec<&str> = options.iter().map(|o| o.family.as_str()).collect();
    assert_eq!(
        families,
        [DEFAULT_FONTS.mono, "alpha Mono", "Iosevka", "Zeta Sans"]
    );
    assert!(options[0].default && options[0].current);
    assert_eq!(options.iter().filter(|o| o.current).count(), 1);
    let generation = theme::generation();
    assert!(theme::set_font(true, "Iosevka", &installed()));
    assert_ne!(
        theme::generation(),
        generation,
        "shaped text caches refresh"
    );
    assert_eq!(current().font_mono, "Iosevka");
    assert_eq!(current().font_ui, before.ui, "the UI font is separate");
    let options = font_options(true, &installed());
    assert!(
        options
            .iter()
            .any(|o| o.family == "Iosevka" && o.current && !o.default)
    );
    assert!(!options[0].current);
    theme::set_font(true, before.mono, &installed());
}

#[test]
fn saved_fonts_round_trip_through_the_store() {
    let path = crate::shell::test_support::scratch_path("o8-next-fonts").join("next-fonts.json");
    assert_eq!(theme::load_fonts(&path), None);
    let fonts = Fonts {
        ui: "Zeta Sans",
        mono: "Iosevka",
    };
    theme::save_fonts(&path, fonts).unwrap();
    assert_eq!(theme::load_fonts(&path), Some(fonts));
    std::fs::write(&path, r#"{"ui": "  ", "mono": "Iosevka"}"#).unwrap();
    assert_eq!(
        theme::load_fonts(&path),
        Some(Fonts {
            ui: DEFAULT_FONTS.ui,
            mono: "Iosevka"
        })
    );
    std::fs::write(&path, "not json").unwrap();
    assert_eq!(theme::load_fonts(&path), None);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn a_missing_family_falls_back_to_the_default_without_a_panic() {
    let _guard = font_test_guard();
    let before = theme::fonts();
    theme::set_font(false, "No Such Family", &installed());
    assert_eq!(current().font_ui, DEFAULT_FONTS.ui);
    // A saved family that was uninstalled since runs in the default.
    theme::set_font(false, "Zeta Sans", &installed());
    assert_eq!(current().font_ui, "Zeta Sans");
    assert!(theme::check_installed_fonts(&["Iosevka".to_string()]));
    assert_eq!(current().font_ui, DEFAULT_FONTS.ui);
    assert!(
        !theme::check_installed_fonts(&installed()),
        "nothing left to change"
    );
    theme::set_font(false, before.ui, &installed());
}
