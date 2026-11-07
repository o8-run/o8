//! Native counterparts of src/app/globals.css. Keep appearance selection here;
//! views consume semantic tokens and never choose their own palette or fonts.
use gpui::{Rgba, rgb};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    Dark,
    Light,
    Glass,
}

#[derive(Clone)]
pub struct Theme {
    pub background: Rgba,
    pub surface: Rgba,
    pub surface_raised: Rgba,
    pub text: Rgba,
    pub text_secondary: Rgba,
    pub text_muted: Rgba,
    pub text_faint: Rgba,
    pub border: Rgba,
    pub hover: Rgba,
    pub accent: Rgba,
    pub danger: Rgba,
    pub success: Rgba,
    pub warning: Rgba,
    pub selection: Rgba,
    pub success_surface: Rgba,
    pub danger_surface: Rgba,
    pub code_background: Rgba,
    pub syntax_string: Rgba,
    pub syntax_link: Rgba,
    pub syntax_emphasis: Rgba,
    pub syntax_keyword: Rgba,
    pub terminal_cursor: Rgba,
    pub terminal_ansi: [u32; 16],
    pub font_ui: &'static str,
    pub font_mono: &'static str,
    /// The handwriting of review notes, as in classic's notes rail.
    pub font_annotation: &'static str,
}

// This is the only appearance selection. Settings › Appearance picks a
// built-in appearance, the system's light or dark, or an imported theme.
// An explicit launch setting wins over the choice saved from the profile menu.
static LAUNCH: LazyLock<u8> = LazyLock::new(|| {
    match std::env::var("O8_NEXT_APPEARANCE")
        .ok()
        .or_else(saved_appearance)
        .as_deref()
        .and_then(choice_id)
    {
        Some(choice) => choice,
        None if cfg!(target_os = "macos") && std::env::args().any(|arg| arg == "--app-shell") => {
            appearance_id(Appearance::Glass)
        }
        None => appearance_id(Appearance::Dark),
    }
});
fn named(mode: &str) -> Option<Appearance> {
    match mode {
        "light" => Some(Appearance::Light),
        "glass" => Some(Appearance::Glass),
        "plain" | "dark" => Some(Appearance::Dark),
        _ => None,
    }
}
/// Choices past the built-in appearances: 3 follows the system, and 4 and up
/// are imported themes by their place in IMPORTED.
const SYSTEM: u8 = 3;
const FIRST_IMPORTED: u8 = 4;
/// A saved or menu name: "light", "dark", "glass", "system" or "theme:<id>".
fn choice_id(mode: &str) -> Option<u8> {
    if let Some(appearance) = named(mode) {
        return Some(appearance_id(appearance));
    }
    if mode == "system" {
        return Some(SYSTEM);
    }
    let id = mode.strip_prefix("theme:")?;
    let themes = IMPORTED.read().unwrap();
    let index = themes.iter().position(|theme| theme.id == id)?;
    u8::try_from(index).ok()?.checked_add(FIRST_IMPORTED)
}
/// The profile menu's choice while the app runs; unset until it switches.
static CHOSEN: AtomicU8 = AtomicU8::new(u8::MAX);
/// Whether the window's system appearance is light, for the System choice.
static SYSTEM_LIGHT: AtomicBool = AtomicBool::new(false);
/// Bumped by every switch that repaints, for caches that keep painted colors.
static GENERATION: AtomicU8 = AtomicU8::new(0);
fn choice() -> u8 {
    match CHOSEN.load(Ordering::Relaxed) {
        u8::MAX => *LAUNCH,
        choice => choice,
    }
}
fn imported(choice: u8) -> Option<&'static ImportedTheme> {
    let index = usize::from(choice.checked_sub(FIRST_IMPORTED)?);
    IMPORTED.read().unwrap().get(index).copied()
}
/// The appearance the running choice is based on: an imported theme follows
/// its own light or dark type, and System follows the window.
fn selected() -> Appearance {
    match choice() {
        0 => Appearance::Dark,
        1 => Appearance::Light,
        2 => Appearance::Glass,
        SYSTEM if SYSTEM_LIGHT.load(Ordering::Relaxed) => Appearance::Light,
        SYSTEM => Appearance::Dark,
        choice => imported(choice).map_or(Appearance::Dark, |theme| theme.base),
    }
}
fn appearance_id(appearance: Appearance) -> u8 {
    match appearance {
        Appearance::Dark => 0,
        Appearance::Light => 1,
        Appearance::Glass => 2,
    }
}
/// Switches the running appearance and saves it for the next launch. True
/// when it changed; the caller then refreshes the window and its material.
pub fn set_appearance(mode: &str) -> bool {
    let Some(next) = choice_id(mode) else {
        return false;
    };
    save_appearance(mode);
    if next == choice() {
        return false;
    }
    CHOSEN.store(next, Ordering::Relaxed);
    GENERATION.fetch_add(1, Ordering::Relaxed);
    true
}
/// Records the window's system appearance. True when the System choice is
/// running and its colors changed; the caller then repaints.
pub fn set_system_light(light: bool) -> bool {
    let changed = SYSTEM_LIGHT.swap(light, Ordering::Relaxed) != light && choice() == SYSTEM;
    if changed {
        GENERATION.fetch_add(1, Ordering::Relaxed);
    }
    changed
}
/// The running choice as Settings names it: "light", "dark", "glass",
/// "system" or "theme:<id>".
pub fn choice_name() -> String {
    match choice() {
        SYSTEM => "system".into(),
        choice if choice >= FIRST_IMPORTED => {
            imported(choice).map_or_else(|| "dark".into(), |theme| format!("theme:{}", theme.id))
        }
        _ => appearance_name().into(),
    }
}
/// A VS Code color theme mapped onto the token set. Imported themes live for
/// the rest of the process, like the built-in token sets.
pub struct ImportedTheme {
    pub id: String,
    pub name: String,
    pub base: Appearance,
    pub theme: Theme,
}
static IMPORTED: LazyLock<RwLock<Vec<&'static ImportedTheme>>> = LazyLock::new(|| {
    RwLock::new(
        themes_path()
            .map(|path| crate::theme_import::load(&path))
            .unwrap_or_default()
            .into_iter()
            .take(MAX_IMPORTED)
            .map(|theme| &*Box::leak(Box::new(theme)))
            .collect(),
    )
});
/// Imported themes as Settings lists them: choice name and label.
pub fn imported_themes() -> Vec<(String, String)> {
    IMPORTED
        .read()
        .unwrap()
        .iter()
        .map(|theme| (format!("theme:{}", theme.id), theme.name.clone()))
        .collect()
}
/// Imports a VS Code color theme and saves it with the appearance choice.
/// Returns its choice name; a theme with the same id is replaced. On an error
/// nothing is saved and nothing changes.
pub fn import_theme(source: &str, fallback_name: &str) -> Result<String, String> {
    let theme = crate::theme_import::parse(source, fallback_name)?;
    let replaces = IMPORTED
        .read()
        .unwrap()
        .iter()
        .any(|old| old.id == theme.id);
    if !replaces && IMPORTED.read().unwrap().len() >= MAX_IMPORTED {
        return Err("Too many imported themes.".into());
    }
    if let Some(path) = themes_path() {
        crate::theme_import::save(&path, &theme.id, source)?;
    }
    let name = format!("theme:{}", theme.id);
    let theme: &'static ImportedTheme = Box::leak(Box::new(theme));
    let mut themes = IMPORTED.write().unwrap();
    match themes.iter().position(|old| old.id == theme.id) {
        Some(index) => themes[index] = theme,
        None => themes.push(theme),
    }
    drop(themes);
    // A replaced theme that is running repaints with its new colors.
    GENERATION.fetch_add(1, Ordering::Relaxed);
    Ok(name)
}
/// Tests that switch the process-wide theme choice hold this so they do not
/// see each other's switches.
#[cfg(test)]
pub(crate) fn selection_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
/// Imported themes fit the choice ids below the unset sentinel.
const MAX_IMPORTED: usize = (u8::MAX - 1 - FIRST_IMPORTED) as usize;
fn themes_path() -> Option<std::path::PathBuf> {
    Some(saved_path()?.with_file_name("next-themes.json"))
}
/// The chat widths Settings offers: saved name, label and width. Comfortable
/// is the composer's designed width.
pub const CHAT_WIDTHS: [(&str, &str, f32); 3] = [
    ("compact", "Compact", 640.),
    ("comfortable", "Comfortable", GEOMETRY.composer_width),
    ("wide", "Wide", 960.),
];
const DEFAULT_CHAT_WIDTH: usize = 1;
static LAUNCH_CHAT_WIDTH: LazyLock<usize> = LazyLock::new(|| {
    saved_chat_width()
        .and_then(|name| chat_width_index(name.trim()))
        .unwrap_or(DEFAULT_CHAT_WIDTH)
});
static CHOSEN_CHAT_WIDTH: AtomicU8 = AtomicU8::new(u8::MAX);
fn chat_width_index(name: &str) -> Option<usize> {
    CHAT_WIDTHS.iter().position(|(id, _, _)| *id == name)
}
fn selected_chat_width() -> usize {
    match CHOSEN_CHAT_WIDTH.load(Ordering::Relaxed) {
        u8::MAX => *LAUNCH_CHAT_WIDTH,
        index => index as usize,
    }
}
/// The transcript and composer width, without the row insets.
pub fn chat_width() -> f32 {
    CHAT_WIDTHS[selected_chat_width()].2
}
pub fn chat_width_name() -> &'static str {
    CHAT_WIDTHS[selected_chat_width()].0
}
/// Switches the chat width and saves it. True when it changed.
pub fn set_chat_width(name: &str) -> bool {
    let Some(index) = chat_width_index(name) else {
        return false;
    };
    if let Some(path) = chat_width_path() {
        let _ = std::fs::write(path, name);
    }
    let changed = index != selected_chat_width();
    CHOSEN_CHAT_WIDTH.store(index as u8, Ordering::Relaxed);
    changed
}
fn chat_width_path() -> Option<std::path::PathBuf> {
    Some(saved_path()?.with_file_name("next-chat-width"))
}
fn saved_chat_width() -> Option<String> {
    std::fs::read_to_string(chat_width_path()?).ok()
}
/// Changes with the appearance, for caches that keep painted colors.
pub fn generation() -> u8 {
    GENERATION.load(Ordering::Relaxed)
}
fn saved_path() -> Option<std::path::PathBuf> {
    if cfg!(test) {
        return None;
    }
    std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".o8/next-appearance"))
}
fn saved_appearance() -> Option<String> {
    Some(
        std::fs::read_to_string(saved_path()?)
            .ok()?
            .trim()
            .to_string(),
    )
}
/// Saves the profile menu's appearance choice for the next launch.
fn save_appearance(mode: &str) {
    if let Some(path) = saved_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, mode);
    }
}
/// The running appearance as the menu names it: "light", "dark" or "glass".
/// System and imported themes name the appearance they are based on.
pub fn appearance_name() -> &'static str {
    match selected() {
        Appearance::Light => "light",
        Appearance::Glass => "glass",
        Appearance::Dark => "dark",
    }
}
/// The UI and code font families Settings › Appearance picked, by name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fonts {
    pub ui: &'static str,
    pub mono: &'static str,
}
pub const DEFAULT_FONTS: Fonts = Fonts {
    ui: UI_FONT,
    mono: MONO_FONT,
};
/// The running token sets for Dark, Light and Glass with the picked fonts.
static ACTIVE: LazyLock<RwLock<(Fonts, [&'static Theme; 3])>> = LazyLock::new(|| {
    let fonts = saved_fonts().unwrap_or(DEFAULT_FONTS);
    RwLock::new((fonts, themes_with(fonts)))
});
/// The fonts as last saved, which may name a family that is not installed
/// right now; the running fonts never do.
static SAVED: LazyLock<Mutex<Fonts>> =
    LazyLock::new(|| Mutex::new(saved_fonts().unwrap_or(DEFAULT_FONTS)));
/// Token sets live for the process, one per font pairing ever picked.
fn themes_with(fonts: Fonts) -> [&'static Theme; 3] {
    static BUILT: Mutex<Vec<(Fonts, [&'static Theme; 3])>> = Mutex::new(Vec::new());
    let mut built = BUILT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((_, themes)) = built.iter().find(|(pair, _)| *pair == fonts) {
        return *themes;
    }
    let themes = [Appearance::Dark, Appearance::Light, Appearance::Glass].map(|appearance| {
        let mut theme = Theme::for_appearance(appearance);
        theme.font_ui = fonts.ui;
        theme.font_mono = fonts.mono;
        &*Box::leak(Box::new(theme))
    });
    built.push((fonts, themes));
    themes
}
pub fn current() -> &'static Theme {
    let active = ACTIVE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match imported(choice()) {
        Some(theme) => imported_with_fonts(&theme.theme, active.0),
        None => active.1[usize::from(appearance_id(selected()))],
    }
}
/// An imported theme's tokens with the picked fonts, built once per pairing.
fn imported_with_fonts(theme: &'static Theme, fonts: Fonts) -> &'static Theme {
    if (theme.font_ui, theme.font_mono) == (fonts.ui, fonts.mono) {
        return theme;
    }
    static BUILT: Mutex<Vec<(usize, Fonts, &'static Theme)>> = Mutex::new(Vec::new());
    let key = theme as *const Theme as usize;
    let mut built = BUILT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((_, _, with_fonts)) = built
        .iter()
        .find(|(source, pair, _)| *source == key && *pair == fonts)
    {
        return with_fonts;
    }
    let with_fonts: &'static Theme = Box::leak(Box::new(Theme {
        font_ui: fonts.ui,
        font_mono: fonts.mono,
        ..theme.clone()
    }));
    built.push((key, fonts, with_fonts));
    with_fonts
}
pub fn fonts() -> Fonts {
    ACTIVE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .0
}
/// A family name kept for the process, so tokens can hold it; one copy each.
fn intern(family: &str) -> &'static str {
    static NAMES: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    if let Some(name) = [UI_FONT, MONO_FONT]
        .into_iter()
        .find(|name| *name == family)
    {
        return name;
    }
    let mut names = NAMES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(name) = names.iter().find(|name| **name == family) {
        return name;
    }
    let name: &'static str = Box::leak(family.to_owned().into_boxed_str());
    names.push(name);
    name
}
/// A family the text system lists, else the default: a missing font never
/// reaches a view.
fn installed_or_default(family: &str, default: &'static str, installed: &[String]) -> &'static str {
    if family != default && installed.iter().any(|name| name == family) {
        intern(family)
    } else {
        default
    }
}
fn apply_fonts(fonts: Fonts) -> bool {
    let mut active = ACTIVE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active.0 == fonts {
        return false;
    }
    *active = (fonts, themes_with(fonts));
    GENERATION.fetch_add(1, Ordering::Relaxed);
    true
}
/// Switches the UI or code font and saves both for the next launch. True when
/// the running fonts changed; the caller then repaints.
pub fn set_font(mono: bool, family: &str, installed: &[String]) -> bool {
    let mut fonts = self::fonts();
    let mut saved = SAVED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if mono {
        fonts.mono = installed_or_default(family, MONO_FONT, installed);
        saved.mono = fonts.mono;
    } else {
        fonts.ui = installed_or_default(family, UI_FONT, installed);
        saved.ui = fonts.ui;
    }
    // The other font keeps its saved family, even one not installed now.
    if let Some(path) = fonts_path() {
        let _ = save_fonts(&path, *saved);
    }
    drop(saved);
    apply_fonts(fonts)
}
/// Runs a saved family that is no longer installed in its default, keeping
/// the saved choice for when it returns. True when the fonts changed.
pub fn check_installed_fonts(installed: &[String]) -> bool {
    let fonts = self::fonts();
    apply_fonts(Fonts {
        ui: if fonts.ui == UI_FONT {
            UI_FONT
        } else {
            installed_or_default(fonts.ui, UI_FONT, installed)
        },
        mono: if fonts.mono == MONO_FONT {
            MONO_FONT
        } else {
            installed_or_default(fonts.mono, MONO_FONT, installed)
        },
    })
}
/// One row of a font picker.
#[derive(Debug, PartialEq, Eq)]
pub struct FontOption {
    pub family: String,
    pub current: bool,
    pub default: bool,
}
/// The UI or code font picker: the default first, then the installed
/// families by name. Names starting with a dot are the system's private
/// faces and are left out.
pub fn font_options(mono: bool, installed: &[String]) -> Vec<FontOption> {
    let default = if mono { MONO_FONT } else { UI_FONT };
    let current = if mono { fonts().mono } else { fonts().ui };
    let mut families: Vec<&str> = installed
        .iter()
        .map(String::as_str)
        .filter(|name| !name.starts_with('.') && *name != default)
        .collect();
    families.sort_by_key(|name| name.to_lowercase());
    families.dedup();
    std::iter::once(default)
        .chain(families)
        .map(|family| FontOption {
            family: family.to_string(),
            current: family == current,
            default: family == default,
        })
        .collect()
}
fn fonts_path() -> Option<std::path::PathBuf> {
    Some(saved_path()?.with_file_name("next-fonts.json"))
}
fn saved_fonts() -> Option<Fonts> {
    load_fonts(&fonts_path()?)
}
/// Saved fonts, as `{"ui": family, "mono": family}`.
pub(crate) fn load_fonts(path: &std::path::Path) -> Option<Fonts> {
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let family = |key: &str, default: &'static str| {
        saved[key]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map_or(default, intern)
    };
    Some(Fonts {
        ui: family("ui", UI_FONT),
        mono: family("mono", MONO_FONT),
    })
}
pub(crate) fn save_fonts(path: &std::path::Path, fonts: Fonts) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        path,
        serde_json::json!({ "ui": fonts.ui, "mono": fonts.mono }).to_string(),
    )
}
pub fn glass() -> bool {
    matches!(selected(), Appearance::Glass)
}
/// Classic AgentStatusDot colours with no semantic token: the grey of a
/// thread waiting on review and the amber of a rejected one.
pub(crate) fn review_mark() -> Rgba {
    rgb(0x94a3b8)
}
pub(crate) fn rejected_mark() -> Rgba {
    rgb(0xf97316)
}
/// Classic's `.scroll-fade-y` mask (globals.css): content fades into `color`
/// at a scroll edge. GPUI has no masks, so this strip paints over the content;
/// it has no hitbox, so clicks and scrolling reach what is under it.
pub(crate) fn edge_fade(bottom: bool, height: f32, color: Rgba) -> gpui::Div {
    use gpui::prelude::*;
    let clear = Rgba { a: 0., ..color };
    // Glass has no solid color to fade into and GPUI cannot mask, so the
    // strip would only paint a dark band; glass goes without (Q 2026-11-01).
    let color = if glass() { clear } else { color };
    gpui::div()
        .absolute()
        .left_0()
        .right_0()
        .h(gpui::px(height))
        .when(bottom, |strip| strip.bottom_0())
        .when(!bottom, |strip| strip.top_0())
        .bg(gpui::linear_gradient(
            if bottom { 180. } else { 0. },
            gpui::linear_color_stop(clear, 0.),
            gpui::linear_color_stop(color, 1.),
        ))
}
pub fn plain_background() -> Rgba {
    if let Some(theme) = imported(choice()) {
        return theme.theme.background;
    }
    Theme::for_appearance(if matches!(selected(), Appearance::Light) {
        Appearance::Light
    } else {
        Appearance::Dark
    })
    .background
}
/// Floating cards (the desktop overlay material). Opaque, because the native
/// shell has no backdrop blur to frost a translucent card over glass.
pub fn popover_background() -> Rgba {
    if let Some(theme) = imported(choice()) {
        return theme.theme.surface_raised;
    }
    match selected() {
        Appearance::Light => rgb(0xffffff),
        Appearance::Glass => rgb(0x3e3f47),
        _ => rgb(0x2c2c2e),
    }
}
// --t-brand-orange in src/lib/theme/registry.ts.
pub fn brand_orange() -> Rgba {
    rgb(0xff5a1f)
}
/// A hue at the saturation and lightness of the Files accent setting,
/// hsl(h, 80%, 55%); `turn` runs from 0 to 1 around the wheel.
pub fn accent_hue(turn: f32) -> gpui::Hsla {
    gpui::hsla(turn, 0.8, 0.55, 1.)
}
/// A project icon color by its stored name, T3's palette: the ink on the
/// surface (-600 in light, -400 otherwise), or the picker's swatch (-500).
pub fn project_icon_color(name: &str, swatch: bool) -> Option<Rgba> {
    let (light, middle, dark) = match name {
        "gray" => (0x4b5563, 0x6b7280, 0x9ca3af),
        "red" => (0xdc2626, 0xef4444, 0xf87171),
        "orange" => (0xea580c, 0xf97316, 0xfb923c),
        "amber" => (0xd97706, 0xf59e0b, 0xfbbf24),
        "yellow" => (0xca8a04, 0xeab308, 0xfacc15),
        "lime" => (0x65a30d, 0x84cc16, 0xa3e635),
        "green" => (0x16a34a, 0x22c55e, 0x4ade80),
        "emerald" => (0x059669, 0x10b981, 0x34d399),
        "teal" => (0x0d9488, 0x14b8a6, 0x2dd4bf),
        "cyan" => (0x0891b2, 0x06b6d4, 0x22d3ee),
        "sky" => (0x0284c7, 0x0ea5e9, 0x38bdf8),
        "blue" => (0x2563eb, 0x3b82f6, 0x60a5fa),
        "indigo" => (0x4f46e5, 0x6366f1, 0x818cf8),
        "violet" => (0x7c3aed, 0x8b5cf6, 0xa78bfa),
        "purple" => (0x9333ea, 0xa855f7, 0xc084fc),
        "fuchsia" => (0xc026d3, 0xd946ef, 0xe879f9),
        "pink" => (0xdb2777, 0xec4899, 0xf472b6),
        "rose" => (0xe11d48, 0xf43f5e, 0xfb7185),
        _ => return None,
    };
    Some(rgb(if swatch {
        middle
    } else if matches!(selected(), Appearance::Light) {
        light
    } else {
        dark
    }))
}
/// The mark drawn on an accent fill, such as the trace's completed check.
/// The color a subagent keeps across its card, tab and header.
pub fn agent_color(index: usize) -> Rgba {
    const COLORS: [u32; 7] = [
        0x3b82f6, 0xa855f7, 0x22c55e, 0xf59e0b, 0xec4899, 0x14b8a6, 0xf97316,
    ];
    gpui::rgb(COLORS[index % COLORS.len()])
}

pub fn on_accent() -> Rgba {
    rgb(0xffffff)
}
/// Language colors for the file-type marks on the thinking trace's chips. The
/// neutral mark covers prose, data files and web pages.
pub struct FileMarks {
    pub typescript: u32,
    pub javascript: u32,
    pub rust: u32,
    pub python: u32,
    pub go: u32,
    pub css: u32,
    pub swift: u32,
    pub neutral: u32,
}
pub const FILE_MARKS: FileMarks = FileMarks {
    typescript: 0x4f9fbf,
    javascript: 0xc9a43a,
    rust: 0xd0875a,
    python: 0x4b8bbe,
    go: 0x4fa8c8,
    css: 0x6c8fd6,
    swift: 0xe0794c,
    neutral: 0x8a8f98,
};
/// Floating menus and tooltips stay opaque: glass surfaces are translucent and
/// would show the content underneath.
pub fn menu_fill() -> Rgba {
    if glass() {
        Theme::for_appearance(Appearance::Dark).surface_raised
    } else {
        current().surface_raised
    }
}
/// No fill: a row or line with nothing behind it.
pub const CLEAR: Rgba = Rgba {
    r: 0.,
    g: 0.,
    b: 0.,
    a: 0.,
};

/// The image markup editor's fixed colors (#5576). Marks and note cards bake
/// into the PNG exactly as drawn, so they stay the same on every appearance,
/// as in the desktop annotator.
pub mod annotate {
    /// Orange, red, blue, green, ink and white.
    pub const PALETTE: [u32; 6] = [0xff5a1f, 0xef4444, 0x3b82f6, 0x22c55e, 0x111827, 0xffffff];
    /// A note card's paper and ink.
    pub const CARD_PAPER: u32 = 0xfffffff5;
    pub const CARD_INK: u32 = 0x161616;
    /// The marks on a card's colored grip, and its delete button's disc.
    pub const GRIP_MARK: u32 = 0xffffffe6;
    pub const GRIP_BUTTON: u32 = 0xffffff47;
    /// The dimmed window behind the editor, and the hint drawn on it.
    pub const SCRIM: u32 = 0x140f0c9e;
    pub const HINT: u32 = 0xffffffcc;
}

/// Activity's fixed tints, the same on every appearance: classic
/// ACTIVITY_COLORS (o8-activity-helpers.tsx) and orchestratorStatusTone
/// (src/lib/orchestrator/display.ts).
pub mod activity {
    pub const ACCENT: u32 = 0x8d9fbd;
    pub const SUCCESS: u32 = 0x70b57f;
    pub const DANGER: u32 = 0xc97878;
    pub const MERGE: u32 = 0xaaa0c7;
    pub const ATTENTION: u32 = 0xcf9d60;
    pub const ADD: u32 = 0x91c99d;
    pub const DELETE: u32 = 0xd99a9a;

    /// A packet status's label, text color, and dot wash with its alpha.
    pub fn packet_tone(status: &str) -> (&'static str, u32, u32, f32) {
        match status {
            "queued" => ("Queued", 0x1d4ed8, 0x2563eb, 0.1),
            "launching" => ("Launching", 0x2563eb, 0x2563eb, 0.12),
            "running" => ("Running", 0x16a34a, 0x16a34a, 0.12),
            "awaiting_review" => ("Reviewing", 0xb45309, 0xf59e0b, 0.12),
            "blocked" => ("Blocked", 0xdc2626, 0xef4444, 0.1),
            "recovering" => ("Recovering", 0x7c3aed, 0x7c3aed, 0.12),
            "failed" => ("Failed", 0x991b1b, 0x991b1b, 0.12),
            "released" => ("Completed", 0x0f766e, 0x14b8a6, 0.12),
            "archived" => ("Archived", 0x6b7280, 0x6b7280, 0.12),
            _ => ("Waiting", 0x64748b, 0x94a3b8, 0.12),
        }
    }
}
/// The rail Update control's ready fill, RailUpdateControl's #3b82f6.
pub fn update_ready() -> Rgba {
    rgb(0x3b82f6)
}
/// A merged pull request's status, GitHub's merged purple.
pub fn pull_merged() -> Rgba {
    rgb(0x8957e5)
}
/// GeminiIcon's mark: its gradient's middle stop, since the mark is filled flat.
pub fn gemini_mark() -> Rgba {
    rgb(0x9b72ff)
}
/// OpenCodeIcon's orange bracket mark.
pub fn opencode_mark() -> Rgba {
    rgb(0xfb923c)
}

/// The right panel column: 30% of the window, at most GEOMETRY.right_width.
pub fn right_panel_width(viewport: f32) -> f32 {
    (viewport * 0.30).min(GEOMETRY.right_width)
}

// src/lib/theme/glass-material.ts: the only window-wide fill in All Glass.
// Darker through the top third, still clear at the bottom.
pub const GLASS_VEIL: [(f32, f32); 4] = [(0., 0.9), (0.3, 0.7), (0.65, 0.32), (1., 0.06)];
/// `--t-glass-muted` in WORKSPACE_GLASS_OVERRIDES (src/lib/theme/context.tsx).
pub fn glass_muted() -> Rgba {
    translucent(0xffffff, 0.04)
}
/// The soft halo around the rail's Symon mark.
pub fn symon_glow() -> Rgba {
    gpui::rgba(0x88d1f173)
}
/// The sidebar's fill. In light it stays flush with the rail (Q 2026-11-01).
pub fn sidebar_fill() -> Rgba {
    if light() {
        Rgba {
            a: 0.,
            ..current().surface
        }
    } else {
        current().surface
    }
}
/// How near the cursor comes before a split lights (Q 2026-11-01).
const SPLIT_WAKE: f32 = 3.;
/// Every resize split's line, so they all match: a faint light blue that wakes
/// when the cursor is near. `center` is the line's offset in its parent.
pub(crate) fn split_line(
    group: impl Into<gpui::SharedString>,
    vertical: bool,
    center: f32,
    lit: bool,
) -> gpui::Div {
    use gpui::prelude::*;
    let group = group.into();
    let glow = rgb(0x88d1f1);
    let opacity = 0.4;
    let span = gpui::px(SPLIT_WAKE * 2. + 1.);
    let zone = gpui::div().group(group.clone()).absolute();
    let line = gpui::div().absolute();
    let (zone, line) = if vertical {
        (
            zone.top_0().bottom_0().left(gpui::px(center - SPLIT_WAKE)).w(span),
            line.top_0().bottom_0().left(gpui::px(SPLIT_WAKE)).w(gpui::px(1.)),
        )
    } else {
        (
            zone.left_0().right_0().top(gpui::px(center - SPLIT_WAKE)).h(span),
            line.left_0().right_0().top(gpui::px(SPLIT_WAKE)).h(gpui::px(1.)),
        )
    };
    zone.child(
        line.bg(glow)
            .shadow(vec![gpui::BoxShadow {
                color: Rgba { a: 0.2, ..glow }.into(),
                offset: gpui::point(gpui::px(0.), gpui::px(0.)),
                blur_radius: gpui::px(3.),
                spread_radius: gpui::px(0.),
            }])
            .opacity(if lit { opacity } else { 0. })
            .group_hover(group, move |style| style.opacity(opacity)),
    )
}
pub fn light() -> bool {
    matches!(selected(), Appearance::Light)
}
pub fn veil_color(alpha: f32) -> Rgba {
    translucent(0x0a0c12, alpha)
}

// Locked chrome roles from docs/design/hurttlocker.md. GPUI's text API does
// not expose CSS letter spacing; native tracking remains a verification gap.
pub struct Typography {
    pub chrome: f32,
    pub row_title: f32,
    pub row_meta: f32,
    pub section: f32,
    pub body: f32,
    pub body_line: f32,
    pub empty: f32,
    pub chrome_line: f32,
    pub weight: gpui::FontWeight,
    pub meta_weight: gpui::FontWeight,
}
pub const TYPE: Typography = Typography {
    chrome: 12.,
    row_title: 13.5,
    row_meta: 9.5,
    section: 10.,
    body: 13.,
    body_line: 20.,
    empty: 28.,
    chrome_line: 1.25,
    weight: gpui::FontWeight(300.),
    meta_weight: gpui::FontWeight(260.),
};
pub struct Geometry {
    pub header: f32,
    pub tab_height: f32,
    pub tab_radius: f32,
    pub row_height: f32,
    pub row_radius: f32,
    pub card_radius: f32,
    pub composer_radius: f32,
    pub composer_width: f32,
    pub sidebar_width: f32,
    pub right_width: f32,
    pub inset: f32,
    pub gap: f32,
    pub content_inset: f32,
}
pub const GEOMETRY: Geometry = Geometry {
    header: 40.,
    tab_height: 26.,
    tab_radius: 7.,
    row_height: 28.,
    row_radius: 8.,
    card_radius: 14.,
    composer_radius: 18.,
    composer_width: 720.,
    sidebar_width: 250.,
    right_width: 440.,
    inset: 4.,
    gap: 8.,
    content_inset: 24.,
};

// GPUI takes one native family, not a CSS fallback stack. These are members of
// --font-sans-system / --font-mono-system; .AppleSystemUIFont is -apple-system.
const UI_FONT: &str = if cfg!(target_os = "macos") {
    ".AppleSystemUIFont"
} else if cfg!(target_os = "windows") {
    "Segoe UI"
} else {
    "system-ui"
};
// Self-hosted from public/fonts by files_panel/spec.rs.
const ANNOTATION_FONT: &str = "Caveat";
const MONO_FONT: &str = if cfg!(target_os = "macos") {
    "Menlo"
} else if cfg!(target_os = "windows") {
    "Consolas"
} else {
    "monospace"
};

// ANSI indices are terminal protocol colors, independent of the UI appearance.
// Preserve the existing palette; indexed cube/grayscale and incoming truecolor
// remain in the terminal parser rather than being reinterpreted as UI tokens.
const TERMINAL_ANSI: [u32; 16] = [
    0x1d2027, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666,
    0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
];

fn translucent(hex: u32, alpha: f32) -> Rgba {
    Rgba {
        a: alpha,
        ..rgb(hex)
    }
}

impl Theme {
    pub fn for_appearance(appearance: Appearance) -> Self {
        // The first sixteen fields follow --bg, --panel, --panel-strong,
        // --text, --text-secondary, --muted, --text-tertiary, --border,
        // --neo-hover-bg (solid surface), --blue, --red, --green, --yellow,
        // --blue-soft, --green-soft and --red-soft in globals.css.
        // Code and syntax colors extend those variables where CSS has no token.
        match appearance {
            Appearance::Glass => {
                let mut theme = Self::for_appearance(Appearance::Dark);
                // WORKSPACE_GLASS_OVERRIDES in src/lib/theme/context.tsx.
                theme.background = translucent(0x000000, 0.);
                theme.surface = theme.background;
                theme.code_background = theme.background;
                theme.surface_raised = translucent(0xffffff, 0.05);
                theme.text = rgb(0xffffff);
                theme.text_secondary = translucent(0xffffff, 0.78);
                theme.text_muted = translucent(0xffffff, 0.66);
                theme.text_faint = translucent(0xffffff, 0.5);
                theme.hover = translucent(0xffffff, 0.04);
                theme.selection = translucent(0xffffff, 0.06);
                theme
            }
            Appearance::Dark => Self {
                background: rgb(0x1c1c1e),
                surface: translucent(0x1c1c1e, 0.82),
                surface_raised: rgb(0x1c1c1e),
                text: rgb(0xf5f5f7),
                text_secondary: rgb(0x98989d),
                text_muted: rgb(0x98989d),
                text_faint: rgb(0x636366),
                border: translucent(0xffffff, 0.08),
                hover: rgb(0x2e323a),
                accent: rgb(0x3b82f6),
                danger: rgb(0xff453a),
                success: rgb(0x30d158),
                warning: rgb(0xffd60a),
                selection: translucent(0x3b82f6, 0.15),
                success_surface: translucent(0x30d158, 0.15),
                danger_surface: translucent(0xff453a, 0.15),
                code_background: rgb(0x16191e),
                syntax_string: rgb(0xa7c6b0),
                syntax_link: rgb(0xb8c8d8),
                syntax_emphasis: rgb(0xd9bd95),
                syntax_keyword: rgb(0xc2b6d7),
                terminal_cursor: translucent(0x3b82f6, 0.5),
                terminal_ansi: TERMINAL_ANSI,
                font_ui: UI_FONT,
                font_mono: MONO_FONT,
                font_annotation: ANNOTATION_FONT,
            },
            Appearance::Light => Self {
                background: rgb(0xf5f7fb),
                surface: translucent(0xffffff, 0.82),
                surface_raised: rgb(0xffffff),
                text: rgb(0x111827),
                text_secondary: rgb(0x64748b),
                text_muted: rgb(0x5b6475),
                text_faint: rgb(0x8e8e93),
                border: translucent(0x0f172a, 0.08),
                hover: rgb(0xf4f2ed),
                accent: rgb(0x2563eb),
                danger: rgb(0xdc2626),
                success: rgb(0x059669),
                warning: rgb(0xb45309),
                selection: translucent(0x2563eb, 0.12),
                success_surface: translucent(0x059669, 0.12),
                danger_surface: translucent(0xdc2626, 0.12),
                code_background: rgb(0xeef1f6),
                syntax_string: rgb(0x116329),
                syntax_link: rgb(0x1d4ed8),
                syntax_emphasis: rgb(0x825012),
                syntax_keyword: rgb(0x6f42c1),
                terminal_cursor: translucent(0x2563eb, 0.5),
                terminal_ansi: TERMINAL_ANSI,
                font_ui: UI_FONT,
                font_mono: MONO_FONT,
                font_annotation: ANNOTATION_FONT,
            },
        }
    }
}

pub fn visualization() -> serde_json::Value {
    let theme = current();
    let css = |color: Rgba| {
        format!(
            "rgba({},{},{},{})",
            color.r * 255.,
            color.g * 255.,
            color.b * 255.,
            color.a
        )
    };
    serde_json::json!({"colorScheme": if matches!(selected(), Appearance::Light) { "light" } else { "dark" }, "variables": {
        "--background":"transparent", "--foreground":css(theme.text), "--muted":css(theme.hover),
        "--muted-foreground":css(theme.text_muted), "--card":css(theme.surface), "--card-foreground":css(theme.text),
        "--popover":css(theme.surface_raised), "--border":css(theme.border), "--accent":css(theme.accent),
        "--accent-foreground":"#172238", "--primary":css(theme.accent), "--primary-foreground":"#172238",
        "--chart-1":css(theme.text), "--chart-2":"#dd835b", "--chart-3":"#70b5c4",
        "--chart-4":"#a599d8", "--chart-5":"#69bea6", "--chart-6":"#d8b16d",
        "--font-sans":"-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif", "--font-mono":"ui-monospace, SFMono-Regular, Consolas, monospace",
    }})
}

#[cfg(test)]
mod chat_width_tests {
    use super::*;

    #[test]
    fn comfortable_is_the_default_chat_width_and_the_designed_one() {
        assert_eq!(CHAT_WIDTHS[DEFAULT_CHAT_WIDTH].0, "comfortable");
        assert_eq!(CHAT_WIDTHS[DEFAULT_CHAT_WIDTH].2, GEOMETRY.composer_width);
        assert_eq!(chat_width_index("wide"), Some(2));
        assert_eq!(chat_width_index("huge"), None);
        assert!(!set_chat_width("huge"));
    }
}
