// o8 Branding v1: replacement values for the "o8-paper" entry in
// native/o8-next/src/theme.rs (mod bespoke, fn themes). Same Colors struct, new values.
build(
    "o8-paper",
    "Paper",
    Appearance::Light,
    Colors {
        background: 0xf4f2ec, // paper
        raised: 0xfdfcfa,     // card
        hover: 0xeeebe2,      // paper-deep
        code: 0xeeebe2,       // paper-deep
        text: 0x17140f,       // ink
        secondary: 0x5c584f,  // ink-muted
        faint: 0x706c64,      // ink-faint
        accent: 0x2563eb,     // link: focus, selection. Orange stays brand_orange() for the one highlight.
        ink: 0x17140f,        // borders and washes are mixed from ink
    },
),
// DESCRIPTIONS[4]: "Warm paper, ink text. o8's own look."
