//! o8's own themes. Each starts from the Dark or Light token set and replaces
//! the colours that give it its character, so a token added later still has
//! a sensible value here.
use crate::theme::{Appearance, ImportedTheme, Theme};
use gpui::{Rgba, rgb};

fn wash(hex: u32, alpha: f32) -> Rgba {
    Rgba { a: alpha, ..rgb(hex) }
}

/// One line on each theme for its card in Settings, in `themes` order.
pub(crate) const DESCRIPTIONS: [&str; 5] = [
    "True black. For OLED and late nights.",
    "Warm charcoal with o8 orange.",
    "Deep sea blue-green.",
    "Violet dusk, after the o8 mark.",
    "Warm paper, ink text.",
];

struct Colors {
    background: u32,
    raised: u32,
    hover: u32,
    code: u32,
    text: u32,
    secondary: u32,
    faint: u32,
    accent: u32,
    /// The colour borders and washes are mixed from: white on dark, ink on light.
    ink: u32,
}

fn build(id: &str, name: &str, base: Appearance, c: Colors) -> ImportedTheme {
    let mut theme = Theme::for_appearance(base);
    theme.background = rgb(c.background);
    theme.surface = rgb(c.background);
    theme.surface_raised = rgb(c.raised);
    theme.hover = rgb(c.hover);
    theme.code_background = rgb(c.code);
    theme.text = rgb(c.text);
    theme.text_secondary = rgb(c.secondary);
    theme.text_muted = rgb(c.secondary);
    theme.text_faint = rgb(c.faint);
    theme.border = wash(c.ink, 0.09);
    theme.accent = rgb(c.accent);
    theme.selection = wash(c.accent, 0.16);
    theme.terminal_cursor = wash(c.accent, 0.5);
    ImportedTheme {
        id: id.into(),
        name: name.into(),
        base,
        theme,
    }
}

pub(crate) fn themes() -> Vec<ImportedTheme> {
    vec![
        build(
            "o8-blackout",
            "Blackout",
            Appearance::Dark,
            Colors {
                background: 0x000000,
                raised: 0x0c0c0d,
                hover: 0x18181a,
                code: 0x070708,
                text: 0xf5f5f7,
                secondary: 0x8e8e93,
                faint: 0x5a5a5f,
                accent: 0x3b82f6,
                ink: 0xffffff,
            },
        ),
        build(
            "o8-ember",
            "Ember",
            Appearance::Dark,
            Colors {
                background: 0x181412,
                raised: 0x221c19,
                hover: 0x2e2622,
                code: 0x13100e,
                text: 0xf6efe9,
                secondary: 0xa8998e,
                faint: 0x6f635a,
                accent: 0xff6a2b,
                ink: 0xfff1e6,
            },
        ),
        build(
            "o8-tidewater",
            "Tidewater",
            Appearance::Dark,
            Colors {
                background: 0x0d1a1f,
                raised: 0x13242b,
                hover: 0x1b323b,
                code: 0x0a1519,
                text: 0xe8f3f5,
                secondary: 0x8fa9b2,
                faint: 0x5c7680,
                accent: 0x2dd4bf,
                ink: 0xe6fbff,
            },
        ),
        build(
            "o8-aurora",
            "Aurora",
            Appearance::Dark,
            Colors {
                background: 0x13121e,
                raised: 0x1b1a2b,
                hover: 0x27253c,
                code: 0x0f0e18,
                text: 0xefedf9,
                secondary: 0x9d99b8,
                faint: 0x69668a,
                accent: 0xa78bfa,
                ink: 0xf0ecff,
            },
        ),
        build(
            "o8-paper",
            "Paper",
            Appearance::Light,
            Colors {
                background: 0xf6f1e7,
                raised: 0xfffdf8,
                hover: 0xece5d6,
                code: 0xeee7d8,
                text: 0x2a2520,
                secondary: 0x6f665a,
                faint: 0x9a9082,
                accent: 0xc2410c,
                ink: 0x2a2520,
            },
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::{DESCRIPTIONS, themes};

    #[test]
    fn every_bespoke_theme_has_a_unique_id_and_a_description() {
        let themes = themes();
        assert_eq!(themes.len(), DESCRIPTIONS.len());
        let mut ids: Vec<_> = themes.iter().map(|theme| theme.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), themes.len());
        assert!(themes.iter().all(|theme| theme.id.starts_with("o8-")));
    }

    #[test]
    fn blackout_is_true_black_and_readable() {
        let blackout = &themes()[0].theme;
        assert_eq!((blackout.background.r, blackout.background.g, blackout.background.b), (0., 0., 0.));
        assert!(blackout.text.r > 0.9 && blackout.background.a == 1.);
    }
}
