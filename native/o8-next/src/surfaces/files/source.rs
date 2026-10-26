//! Bounded read-only source model; masking and syntax parsing run off the UI thread.
use super::guard;
use crate::theme::current as theme;
use gpui::Rgba;
use std::ops::Range;
#[derive(Clone, Copy)]
pub(crate) enum Style {
    Comment,
    String,
    Keyword,
    Number,
    Link,
}
impl Style {
    pub fn color(self) -> Rgba {
        match self {
            Self::Comment => theme().text_secondary,
            Self::String => theme().syntax_string,
            Self::Keyword => theme().syntax_keyword,
            Self::Number => theme().syntax_emphasis,
            Self::Link => theme().syntax_link,
        }
    }
}
pub(crate) struct Line {
    pub text: String,
    pub styles: Vec<(Range<usize>, Style)>,
}
#[derive(Default)]
pub(crate) struct Source {
    pub content: String,
    pub lines: Vec<Line>,
    pub masked: bool,
    pub binary: bool,
    pub truncated: bool,
}
impl Source {
    pub fn new(path: &str, raw: &str, binary: bool, truncated: bool) -> Self {
        if binary {
            return Self {
                binary,
                truncated,
                ..Self::default()
            };
        }
        let bounded: String = raw.chars().take(100_000).collect();
        let truncated = truncated || bounded.len() < raw.len();
        // No original private source enters the render model or clipboard.
        if guard::sensitive(&bounded) {
            return Self {
                content: "[masked]".into(),
                masked: true,
                truncated,
                ..Self::default()
            };
        }
        let language: Option<tree_sitter::Language> = match path.rsplit('.').next().unwrap_or("") {
            "ts" | "js" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
            "tsx" | "jsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
            "rs" => Some(tree_sitter_rust::LANGUAGE.into()),
            "json" => Some(tree_sitter_json::LANGUAGE.into()),
            "md" | "markdown" => Some(tree_sitter_md::LANGUAGE.into()),
            _ => None,
        };
        let mut spans = vec![];
        if let Some(language) = language {
            let mut parser = tree_sitter::Parser::new();
            if parser.set_language(&language).is_ok()
                && let Some(tree) = parser.parse(&bounded, None)
            {
                let mut pending = vec![tree.root_node()];
                while let Some(node) = pending.pop() {
                    let kind = node.kind();
                    let style = if kind.contains("comment") {
                        Some(Style::Comment)
                    } else if kind.contains("string") || kind == "char_literal" {
                        Some(Style::String)
                    } else if kind.contains("heading") {
                        Some(Style::Link)
                    } else if kind.contains("type")
                        || [
                            "const", "let", "var", "function", "return", "fn", "pub", "use",
                            "impl", "struct", "enum", "if", "else", "match", "for", "while",
                            "async", "await", "export", "true", "false", "null",
                        ]
                        .contains(&kind)
                    {
                        Some(Style::Keyword)
                    } else if kind.contains("integer") || kind.contains("float") || kind == "number"
                    {
                        Some(Style::Number)
                    } else {
                        None
                    };
                    if let Some(style) = style {
                        spans.push((node.byte_range(), style));
                    } else {
                        let mut cursor = node.walk();
                        pending.extend(node.children(&mut cursor));
                    }
                }
            }
        }
        spans.sort_by_key(|(range, _)| range.start);
        let mut offset = 0;
        let mut first = 0;
        let lines = bounded
            .split('\n')
            .map(|raw| {
                let mut text: String = raw.chars().take(2_048).collect();
                let length = text.len();
                if length < raw.len() {
                    text.push('…');
                }
                while first < spans.len() && spans[first].0.end <= offset {
                    first += 1;
                }
                let styles = spans[first..]
                    .iter()
                    .take_while(|(range, _)| range.start < offset + length)
                    .filter_map(|(range, style)| {
                        let start = range.start.max(offset) - offset;
                        let end = range.end.min(offset + length) - offset;
                        (start < end).then_some((start..end, *style))
                    })
                    .collect();
                offset += raw.len() + 1;
                Line { text, styles }
            })
            .collect();
        Self {
            content: bounded,
            lines,
            masked: false,
            binary: false,
            truncated,
        }
    }
    pub fn copyable(&self) -> bool {
        !self.masked && !self.binary && !self.truncated
    }
}
