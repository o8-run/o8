//! File-only CommonMark block structure. Chat keeps text::markdown unchanged.
//! Reuse the already-installed Markdown grammar and transcript inline runs.
use crate::text::{Node, Run, inline};
use serde_json::json;
use tree_sitter::{Node as Ast, Parser};

pub(super) fn parse(source: &str) -> Vec<Node> {
    let source = source.replace("\r\n", "\n");
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_md::LANGUAGE.into())
        .expect("Markdown grammar");
    let tree = parser.parse(&source, None).expect("file Markdown tree");
    let mut nodes = Vec::new();
    blocks(tree.root_node(), &source, 0, &mut nodes);
    nodes
}
fn text<'a>(node: Ast, source: &'a str) -> &'a str {
    &source[node.byte_range()]
}
fn node(kind: &str, runs: Vec<Run>) -> Node {
    Node {
        kind: kind.into(),
        runs,
        language: None,
        data: None,
    }
}
fn child<'a>(ast: Ast<'a>, kind: &str) -> Option<Ast<'a>> {
    ast.named_children(&mut ast.walk())
        .find(|n| n.kind() == kind)
}
// Container prefixes are block syntax, not paragraph text. Retain any newline
// in a continuation token so explicit hard breaks still reach the inline tree.
fn inline_source(ast: Ast, source: &str) -> String {
    let mut result = String::new();
    let mut at = ast.start_byte();
    for prefix in ast
        .named_children(&mut ast.walk())
        .filter(|n| n.kind() == "block_continuation")
    {
        result.push_str(&source[at..prefix.start_byte()]);
        result.extend(text(prefix, source).chars().filter(|c| *c == '\n'));
        at = prefix.end_byte();
    }
    result.push_str(&source[at..ast.end_byte()]);
    result
}
fn hard_ranges(ast: Ast, ranges: &mut Vec<std::ops::Range<usize>>) {
    if ast.kind() == "hard_line_break" {
        ranges.push(ast.byte_range());
        return;
    }
    for c in ast.named_children(&mut ast.walk()) {
        hard_ranges(c, ranges);
    }
}
fn prose(ast: Ast, source: &str) -> Vec<Run> {
    let value = inline_source(ast, source);
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_md::INLINE_LANGUAGE.into())
        .expect("Markdown inline grammar");
    let tree = parser.parse(&value, None).expect("inline tree");
    let mut hard = Vec::new();
    hard_ranges(tree.root_node(), &mut hard);
    let soft = |s: &str| s.split('\n').map(str::trim).collect::<Vec<_>>().join(" ");
    let mut normalized = String::new();
    let mut at = 0;
    for range in hard {
        normalized.push_str(&soft(&value[at..range.start]));
        normalized.push('\n');
        at = range.end;
    }
    normalized.push_str(&soft(&value[at..]));
    inline(&normalized)
}
fn paragraph(ast: Ast, source: &str, kind: &str, depth: usize) -> Node {
    let runs = child(ast, "inline")
        .map(|n| prose(n, source))
        .unwrap_or_default();
    let mut n = node(kind, runs);
    if kind == "ul" || kind.starts_with("ol:") || kind == "li-p" {
        n.data = Some(json!({"depth":depth}));
    }
    n
}
fn blocks(ast: Ast, source: &str, depth: usize, out: &mut Vec<Node>) {
    match ast.kind() {
        "paragraph" => out.push(paragraph(ast, source, "p", depth)),
        "atx_heading" | "setext_heading" => {
            let level = if ast.kind() == "setext_heading" {
                if text(ast, source)
                    .lines()
                    .last()
                    .unwrap_or("")
                    .trim_start()
                    .starts_with('=')
                {
                    1
                } else {
                    2
                }
            } else {
                ast.named_children(&mut ast.walk())
                    .find_map(|n| {
                        n.kind()
                            .strip_prefix("atx_h")
                            .and_then(|s| s.chars().next())
                            .and_then(|c| c.to_digit(10))
                    })
                    .unwrap_or(1)
            };
            let runs = child(ast, "inline")
                .map(|n| prose(n, source))
                .unwrap_or_default();
            out.push(node(&format!("h{level}"), runs));
        }
        "list" => {
            for item in ast
                .named_children(&mut ast.walk())
                .filter(|n| n.kind() == "list_item")
            {
                let marker = item
                    .named_children(&mut item.walk())
                    .find(|n| n.kind().starts_with("list_marker_"));
                let kind = marker
                    .map(|m| {
                        if matches!(m.kind(), "list_marker_dot" | "list_marker_parenthesis") {
                            format!("ol:{}", text(m, source).trim())
                        } else {
                            "ul".into()
                        }
                    })
                    .unwrap_or_else(|| "ul".into());
                let mut first = true;
                for part in item.named_children(&mut item.walk()) {
                    match part.kind() {
                        "paragraph" => {
                            out.push(paragraph(
                                part,
                                source,
                                if first { &kind } else { "li-p" },
                                depth,
                            ));
                            first = false;
                        }
                        "list" => blocks(part, source, depth + 1, out),
                        _ => blocks(part, source, depth, out),
                    }
                }
            }
        }
        "fenced_code_block" | "indented_code_block" => {
            let code = if let Some(content) = child(ast, "code_fence_content") {
                inline_source(content, source)
            } else {
                text(ast, source)
                    .lines()
                    .map(|line| line.strip_prefix("    ").unwrap_or(line))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let mut n = node(
                "code-block",
                vec![Run {
                    style: "code".into(),
                    text: code.trim_end_matches('\n').into(),
                }],
            );
            n.language = child(ast, "info_string").map(|n| text(n, source).trim().to_owned());
            out.push(n);
        }
        "pipe_table" => {
            let cells = |row: Ast| {
                row.named_children(&mut row.walk())
                    .filter(|n| n.kind() == "pipe_table_cell")
                    .map(|n| inline(text(n, source).trim()))
                    .collect::<Vec<_>>()
            };
            let headers = child(ast, "pipe_table_header")
                .map(cells)
                .unwrap_or_default();
            let rows: Vec<_> = ast
                .named_children(&mut ast.walk())
                .filter(|n| n.kind() == "pipe_table_row")
                .map(cells)
                .collect();
            let aligns: Vec<_> = child(ast, "pipe_table_delimiter_row")
                .map(|n| {
                    text(n, source)
                        .trim()
                        .trim_matches('|')
                        .split('|')
                        .map(|s| {
                            let s = s.trim();
                            if s.starts_with(':') && s.ends_with(':') {
                                "center"
                            } else if s.ends_with(':') {
                                "right"
                            } else {
                                "left"
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            let mut n = node("table", vec![]);
            n.data = Some(json!({"headers":headers,"rows":rows,"aligns":aligns}));
            out.push(n);
        }
        "block_quote" => {
            let start = out.len();
            for part in ast.named_children(&mut ast.walk()) {
                blocks(part, source, depth, out);
            }
            for n in &mut out[start..] {
                if n.kind == "p" {
                    n.kind = "quote".into();
                }
            }
        }
        "thematic_break" => out.push(node("rule", vec![])),
        "html_block" => out.push(node("p", inline(text(ast, source).trim()))),
        "document" | "section" => {
            for part in ast.named_children(&mut ast.walk()) {
                blocks(part, source, depth, out);
            }
        }
        _ => {}
    }
}
