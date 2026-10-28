//! Native counterparts of src/app/globals.css. Keep appearance selection here;
//! views consume semantic tokens and never choose their own palette or fonts.
use gpui::{Rgba, rgb};
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug)]
pub enum Appearance {
    Dark,
    Light,
    Glass,
}

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
}

// This is the only appearance selection. A future system-appearance hook can
// replace it without changing any view's choice of semantic tokens.
static SELECTED: LazyLock<Appearance> =
    LazyLock::new(|| match std::env::var("O8_NEXT_APPEARANCE").as_deref() {
        Ok("light") => Appearance::Light,
        Ok("glass") => Appearance::Glass,
        Ok("plain") => Appearance::Dark,
        Ok("light") => Appearance::Light,
        _ if cfg!(target_os = "macos") && std::env::args().any(|arg| arg == "--app-shell") => {
            Appearance::Glass
        }
        _ => Appearance::Dark,
    });
static CURRENT: LazyLock<Theme> = LazyLock::new(|| Theme::for_appearance(*SELECTED));
pub fn current() -> &'static Theme {
    &CURRENT
}
pub fn glass() -> bool {
    matches!(*SELECTED, Appearance::Glass)
}
pub fn plain_background() -> Rgba {
    Theme::for_appearance(Appearance::Dark).background
}
/// Floating menus stay opaque: glass surfaces are translucent and would show
/// the transcript through them.
pub fn menu_fill() -> Rgba {
    if glass() {
        Theme::for_appearance(Appearance::Dark).surface_raised
    } else {
        current().surface_raised
    }
}

// src/lib/theme/glass-material.ts: the only window-wide fill in All Glass.
pub const GLASS_VEIL: [(f32, f32); 3] = [(0., 0.78), (0.55, 0.44), (1., 0.06)];
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
            },
        }
    }
}
