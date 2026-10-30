use regex::Regex;
use std::{fs, path::Path};

fn string_value(node: tree_sitter::Node) -> bool {
    if matches!(node.kind(), "string_literal" | "raw_string_literal") {
        return true;
    }
    // Strings used to choose a style are not font-family values.
    if node.kind() == "if_expression" {
        return ["consequence", "alternative"]
            .into_iter()
            .any(|field| node.child_by_field_name(field).is_some_and(string_value));
    }
    if node.kind() == "match_arm" {
        return node.child_by_field_name("value").is_some_and(string_value);
    }
    node.named_children(&mut node.walk()).any(string_value)
}

/// Where the parser first failed, so a refusal names the line to fix.
fn first_error(node: tree_sitter::Node) -> Option<tree_sitter::Point> {
    if node.is_error() || node.is_missing() {
        return Some(node.start_position());
    }
    node.children(&mut node.walk()).find_map(first_error)
}

fn font_literal(node: tree_sitter::Node, source: &[u8]) -> bool {
    if node.kind() == "call_expression" {
        let function = node
            .child_by_field_name("function")
            .unwrap()
            .utf8_text(source)
            .unwrap();
        if (function == "font"
            || function.ends_with("::font")
            || function.ends_with(".font_family"))
            && node
                .child_by_field_name("arguments")
                .is_some_and(string_value)
        {
            return true;
        }
    }
    node.named_children(&mut node.walk())
        .any(|child| font_literal(child, source))
}

fn sources(directory: &Path, violations: &mut Vec<String>) {
    let raw_color = Regex::new(r"\b(?:rgb|rgba)\s*\(\s*(?:0x[\da-fA-F_]+|\d)").unwrap();
    let color_in_branch = Regex::new(r"\b0x[\da-fA-F]{6,8}\b").unwrap();
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, violations);
        } else if path.extension().is_some_and(|ext| ext == "rs")
            && path.file_name().unwrap() != "theme.rs"
        {
            let source = fs::read_to_string(&path).unwrap();
            for (line, text) in source.lines().enumerate() {
                if raw_color.is_match(text) {
                    violations.push(format!(
                        "{}:{}",
                        path.file_name().unwrap().to_string_lossy(),
                        line + 1
                    ));
                }
                // Also catch conditional colors and retained/syntax palettes,
                // rather than permitting a literal hidden behind rgb(variable).
                if color_in_branch.is_match(text)
                    && !path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .ends_with("_tests.rs")
                    && !text.contains("0xfefefe")
                    && !text.contains("0x010101")
                {
                    violations.push(format!(
                        "{}:{}",
                        path.file_name().unwrap().to_string_lossy(),
                        line + 1
                    ));
                }
            }
            let mut parser = tree_sitter::Parser::new();
            parser
                .set_language(&tree_sitter_rust::LANGUAGE.into())
                .unwrap();
            let tree = parser.parse(&source, None).unwrap();
            if let Some(at) = first_error(tree.root_node()) {
                panic!(
                    "valid Rust source: {}:{}:{}",
                    path.display(),
                    at.row + 1,
                    at.column + 1
                );
            }
            if font_literal(tree.root_node(), source.as_bytes()) {
                violations.push(format!(
                    "{}: font family literal",
                    path.file_name().unwrap().to_string_lossy()
                ));
            }
        }
    }
}

#[test]
fn native_styles_use_theme_tokens() {
    let mut violations = vec![];
    sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut violations,
    );
    violations.sort();
    violations.dedup();
    assert!(
        violations.is_empty(),
        "styles outside theme.rs: {}\n{}",
        violations.len(),
        violations.join("\n")
    );
}

#[test]
fn chrome_metrics_follow_the_locked_desktop_sources() {
    use crate::theme::{GEOMETRY, TYPE};
    let spec = include_str!("../../../docs/design/hurttlocker.md");
    let number = Regex::new(r"\d+(?:\.\d+)?").unwrap();
    for (role, size, weight) in [
        ("Row title", TYPE.row_title, TYPE.weight.0),
        ("Row meta", TYPE.row_meta, TYPE.meta_weight.0),
        ("Tab pill", TYPE.chrome, TYPE.weight.0),
    ] {
        let row = spec
            .lines()
            .find(|line| line.starts_with(&format!("| **{role}**")))
            .unwrap();
        let cells: Vec<_> = row.split('|').collect();
        let value = |cell: &str| number.find(cell).unwrap().as_str().parse::<f32>().unwrap();
        assert_eq!(size, value(cells[2]), "{role} size");
        assert_eq!(weight, value(cells[3]), "{role} weight");
    }
    for (source, key, native) in [
        (
            include_str!("../../../src/components/desktop/shell/shell-geometry.ts"),
            "SHELL_HEADER_HEIGHT",
            GEOMETRY.header,
        ),
        (
            include_str!("../../../src/components/desktop/shell/shell-geometry.ts"),
            "SHELL_EDGE_INSET",
            GEOMETRY.inset,
        ),
        (
            include_str!("../../../src/components/desktop/repo-focus/tabs/chats/constants.ts"),
            "COMPACT_CHAT_ROW_HEIGHT",
            GEOMETRY.row_height,
        ),
        (
            include_str!("../../../src/components/desktop/repo-focus/tabs/chats/constants.ts"),
            "CHAT_ROW_RADIUS",
            GEOMETRY.row_radius,
        ),
    ] {
        let pattern = Regex::new(&format!(r"export const {key} = ([\d.]+);")).unwrap();
        assert_eq!(
            native,
            pattern.captures(source).unwrap()[1].parse::<f32>().unwrap(),
            "{key}"
        );
    }
    let composer = include_str!("../../../src/components/desktop/llm-chat/Composer.tsx");
    let card = composer
        .lines()
        .find(|line| line.contains("transition: 'border-color"))
        .unwrap();
    for (key, native) in [
        ("maxWidth", GEOMETRY.composer_width),
        ("borderRadius", GEOMETRY.composer_radius),
    ] {
        let pattern = Regex::new(&format!(r"{key}: ([\d.]+)")).unwrap();
        assert_eq!(
            native,
            pattern.captures(card).unwrap()[1].parse::<f32>().unwrap()
        );
    }
}

fn css_color(block: &str, variable: &str) -> gpui::Rgba {
    let value = block
        .split(&format!("{variable}:"))
        .nth(1)
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .trim();
    if let Some(hex) = value.strip_prefix('#') {
        gpui::rgb(u32::from_str_radix(hex, 16).unwrap())
    } else {
        let parts: Vec<f32> = value
            .strip_prefix("rgba(")
            .unwrap()
            .trim_end_matches(')')
            .split(',')
            .map(|v| v.trim().parse().unwrap())
            .collect();
        gpui::Rgba {
            r: parts[0] / 255.,
            g: parts[1] / 255.,
            b: parts[2] / 255.,
            a: parts[3],
        }
    }
}

#[test]
fn glass_tokens_match_the_desktop_overrides_and_window_veil() {
    let theme = crate::theme::Theme::for_appearance(crate::theme::Appearance::Glass);
    let context = include_str!("../../../src/lib/theme/context.tsx");
    let overrides = context
        .split("const WORKSPACE_GLASS_OVERRIDES")
        .nth(1)
        .unwrap()
        .split("};")
        .next()
        .unwrap();
    for (token, native) in [
        ("--t-panel", theme.surface),
        ("--t-chat-surface-bg", theme.background),
        ("--t-terminal-bg", theme.code_background),
        ("--t-glass-elevated", theme.surface_raised),
        ("--t-chat-surface-text", theme.text),
        ("--t-chat-surface-text-secondary", theme.text_secondary),
        ("--t-text-muted", theme.text_muted),
        ("--t-text-faint", theme.text_faint),
        ("--t-glass-muted", theme.hover),
        ("--t-input-bg", theme.selection),
    ] {
        let pattern = Regex::new(&format!("'{}': '([^']+)'", regex::escape(token))).unwrap();
        let value = &pattern.captures(overrides).unwrap()[1];
        if value == "transparent" {
            assert_eq!(native.a, 0., "{token}");
        } else {
            assert_eq!(
                native,
                css_color(&format!("color:{value};"), "color"),
                "{token}"
            );
        }
    }
    let veil = include_str!("../../../src/lib/theme/glass-material.ts")
        .lines()
        .find(|line| line.contains("WORKSPACE_GLASS_VEIL ="))
        .unwrap();
    let pattern = Regex::new(r"(rgba\([^)]+\)) (\d+)%").unwrap();
    let stops: Vec<_> = pattern.captures_iter(veil).collect();
    // The native veil is deliberately darker at the top than classic's three
    // stops: four stops since 78fb95459, kept by Q on 2026-10-29. It keeps
    // classic's tint and its transparent foot.
    assert_eq!(
        crate::theme::GLASS_VEIL,
        [(0., 0.9), (0.3, 0.7), (0.65, 0.32), (1., 0.06)]
    );
    let tint = |color: gpui::Rgba| (color.r, color.g, color.b);
    for capture in &stops {
        assert_eq!(
            tint(css_color(&format!("color:{};", &capture[1]), "color")),
            tint(crate::theme::veil_color(1.))
        );
    }
    let foot = stops.last().unwrap();
    assert_eq!(foot[2].parse::<f32>().unwrap() / 100., 1.);
    assert_eq!(
        css_color(&format!("color:{};", &foot[1]), "color"),
        crate::theme::veil_color(crate::theme::GLASS_VEIL[3].1)
    );
}

#[test]
fn every_theme_token_resolves_for_both_appearances_and_matches_desktop_css() {
    use crate::theme::{Appearance, Theme, current};
    let css = include_str!("../../../src/app/globals.css");
    for appearance in [Appearance::Dark, Appearance::Light] {
        // No `..`: adding a field requires exercising the new token here.
        let Theme {
            background,
            surface,
            surface_raised,
            text,
            text_secondary,
            text_muted,
            text_faint,
            border,
            hover,
            accent,
            danger,
            success,
            warning,
            selection,
            success_surface,
            danger_surface,
            code_background,
            syntax_string,
            syntax_link,
            syntax_emphasis,
            syntax_keyword,
            terminal_cursor,
            terminal_ansi,
            font_ui,
            font_mono,
            font_annotation,
        } = Theme::for_appearance(appearance);
        // Review notes use the desktop's self-hosted handwriting face.
        assert!(css.contains(&format!("font-family: '{font_annotation}';")));
        let (selector, hover_selector) = match appearance {
            Appearance::Dark => (
                ":root.dark-mode, .dark-mode {",
                "html[data-palette='dark'][data-surface='solid'] {",
            ),
            Appearance::Light => (
                ":root {",
                "html[data-palette='light'][data-surface='solid'] {",
            ),
            Appearance::Glass => unreachable!("glass has its own desktop override contract"),
        };
        let block = css
            .split(selector)
            .nth(1)
            .unwrap()
            .split('}')
            .next()
            .unwrap();
        for (name, color) in [
            ("--bg", background),
            ("--panel", surface),
            ("--panel-strong", surface_raised),
            ("--text", text),
            ("--text-secondary", text_secondary),
            ("--muted", text_muted),
            ("--text-tertiary", text_faint),
            ("--border", border),
            ("--blue", accent),
            ("--red", danger),
            ("--green", success),
            ("--yellow", warning),
            ("--blue-soft", selection),
            ("--green-soft", success_surface),
            ("--red-soft", danger_surface),
        ] {
            assert_eq!(color, css_color(block, name), "{appearance:?}: {name}");
        }
        let hover_block = css
            .split(hover_selector)
            .nth(1)
            .unwrap()
            .split('}')
            .next()
            .unwrap();
        assert_eq!(hover, css_color(hover_block, "--neo-hover-bg"));
        for color in [
            code_background,
            syntax_string,
            syntax_link,
            syntax_emphasis,
            syntax_keyword,
            terminal_cursor,
        ] {
            for channel in [color.r, color.g, color.b, color.a] {
                assert!(channel.is_finite() && (0.0..=1.0).contains(&channel));
            }
            assert!(color.a > 0.0);
        }
        for color in terminal_ansi {
            assert!(color <= (1 << 24) - 1);
        }
        let font_block = css
            .split(":root {")
            .nth(1)
            .unwrap()
            .split('}')
            .next()
            .unwrap();
        for (variable, family) in [
            ("--font-sans-system", font_ui),
            ("--font-mono-system", font_mono),
        ] {
            let stack = font_block
                .split(&format!("{variable}:"))
                .nth(1)
                .unwrap()
                .split(';')
                .next()
                .unwrap();
            // GPUI's native system-font name corresponds to CSS -apple-system.
            let css_family = if family == ".AppleSystemUIFont" {
                "-apple-system"
            } else {
                family
            };
            assert!(
                stack
                    .split(',')
                    .any(|font| font.trim().trim_matches('"') == css_family),
                "{variable}: {family}"
            );
        }
    }
    assert_eq!(
        current().font_ui,
        Theme::for_appearance(Appearance::Dark).font_ui
    );
}
