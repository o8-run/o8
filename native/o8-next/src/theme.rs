//! Native counterparts of src/app/globals.css. Keep appearance selection here;
//! views consume semantic tokens and never choose their own palette or fonts.
use gpui::{Rgba, rgb};
use std::{cell::Cell, sync::LazyLock};

#[derive(Clone, Copy, Debug)]
pub enum Appearance {
    Dark,
    Light,
}

pub struct Theme {
    pub background: Rgba,
    pub shell_background: Rgba,
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
}

// Startup preferences select semantic tokens before opening the shell. GPUI
// owns one UI thread; a test window's selection stays on its own test thread.
static DARK: LazyLock<Theme> = LazyLock::new(|| Theme::for_appearance(Appearance::Dark));
static LIGHT: LazyLock<Theme> = LazyLock::new(|| Theme::for_appearance(Appearance::Light));
static DARK_GLASS: LazyLock<Theme> = LazyLock::new(|| glass_theme(Appearance::Dark, false));
static LIGHT_GLASS: LazyLock<Theme> = LazyLock::new(|| glass_theme(Appearance::Light, false));
static ALL_GLASS: LazyLock<Theme> = LazyLock::new(|| glass_theme(Appearance::Dark, true));
#[derive(Clone, Copy)]
struct Choice {
    light: bool,
    glass: bool,
    all_glass: bool,
    width: f32,
    visible: bool,
}
thread_local! {
    static CHOICE: Cell<Choice> = const { Cell::new(Choice { light: false, glass: false, all_glass: false, width: 250., visible: true }) };
}
pub fn configure(palette: &str, glass: bool, all_glass: bool, width: f32, visible: bool) {
    let glass = glass && cfg!(target_os = "macos");
    CHOICE.set(Choice {
        light: palette == "light" && !(glass && all_glass),
        glass,
        all_glass: glass && all_glass,
        width,
        visible,
    });
}
pub fn glass_enabled() -> bool {
    CHOICE.get().glass
}
pub fn sidebar_width() -> f32 {
    let choice = CHOICE.get();
    if choice.visible { choice.width } else { 0. }
}
pub fn sidebar_inset() -> f32 {
    if CHOICE.get().visible { 8. } else { 0. }
}
fn glass_theme(appearance: Appearance, all: bool) -> Theme {
    let mut theme = Theme::for_appearance(appearance);
    theme.shell_background.a = 0.;
    if all {
        theme.background.a = 0.;
        theme.surface.a = 0.;
    }
    theme
}
pub fn current() -> &'static Theme {
    let choice = CHOICE.get();
    if choice.all_glass {
        &ALL_GLASS
    } else if choice.glass && choice.light {
        &LIGHT_GLASS
    } else if choice.glass {
        &DARK_GLASS
    } else if choice.light {
        &LIGHT
    } else {
        &DARK
    }
}

// GPUI takes one native family, not a CSS fallback stack. These are members of
// --font-sans-system / --font-mono-system; .AppleSystemUIFont is -apple-system.
const UI_FONT: &str = if cfg!(target_os = "macos") {
    ".AppleSystemUIFont"
} else if cfg!(target_os = "windows") {
    "Segoe UI"
} else {
    "system-ui"
};
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
            Appearance::Dark => Self {
                background: rgb(0x1c1c1e),
                shell_background: rgb(0x1c1c1e),
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
            },
            Appearance::Light => Self {
                background: rgb(0xf5f7fb),
                shell_background: rgb(0xf5f7fb),
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
            },
        }
    }
}
