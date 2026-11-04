// Entity relationship diagrams: `erDiagram`.
//
// Ported from Pele (https://github.com/obsidianmd/pele), MIT License,
// Copyright (c) 2026 kepano and the Pele contributors.
// Upstream paths: src/diagrams/er/lexer.ts, parser.ts, db.ts and markers.ts at
// commit 3a2f075ee0c3d914f0fad3545fc0f193693975ac.
// The symbolic cardinalities, the solid identifying and dotted non-identifying
// lines, attribute blocks with keys, and the crow's foot markers follow it.
// Word cardinalities, aliases and subgraphs fall back to the code block. See
// NOTICE.md and licenses/pele-MIT.txt.
use super::{
    parse::{LIMIT, quoted, text},
    *,
};

/// The cardinality at the first entity's end, written before the line.
const LEFT: [(&str, Marker); 4] = [
    ("|o", Marker::ZeroOrOne),
    ("||", Marker::OnlyOne),
    ("}o", Marker::ZeroOrMore),
    ("}|", Marker::OneOrMore),
];
/// The cardinality at the second entity's end, written after the line.
const RIGHT: [(&str, Marker); 4] = [
    ("o|", Marker::ZeroOrOne),
    ("||", Marker::OnlyOne),
    ("o{", Marker::ZeroOrMore),
    ("|{", Marker::OneOrMore),
];

/// An entity name, bare or quoted, and the rest.
fn name(input: &str) -> Result<(&str, &str), ParseError> {
    let input = input.trim_start();
    if let Some((value, rest)) = quoted(input) {
        return Ok((value, rest));
    }
    let end = input
        .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .unwrap_or(input.len());
    if end > 512 {
        return Err(ParseError::Limit);
    }
    if end == 0 {
        return Err(ParseError::Unsupported);
    }
    Ok((&input[..end], input[end..].trim_start()))
}
fn entity(nodes: &mut Vec<Vertex>, id: &str) -> Result<usize, ParseError> {
    if let Some(index) = nodes.iter().position(|n| n.id == id) {
        return Ok(index);
    }
    if nodes.len() >= LIMIT {
        return Err(ParseError::Limit);
    }
    nodes.push(Vertex {
        id: id.into(),
        label: text(id)?,
        shape: Shape::Class,
        ..Default::default()
    });
    Ok(nodes.len() - 1)
}
/// `type name [PK|FK|UK, …] ["comment"]`, shown as its type, name and keys.
fn attribute(input: &str) -> Result<String, ParseError> {
    let input = match input.find('"') {
        Some(comment) => {
            let (_, rest) = quoted(&input[comment..]).ok_or(ParseError::Unsupported)?;
            if !rest.is_empty() {
                return Err(ParseError::Unsupported);
            }
            &input[..comment]
        }
        None => input,
    };
    let mut words = input.split_whitespace();
    let (Some(kind), Some(name)) = (words.next(), words.next()) else {
        return Err(ParseError::Unsupported);
    };
    let keys: Vec<&str> = words
        .flat_map(|word| word.split(','))
        .filter(|key| !key.is_empty())
        .collect();
    if !keys.iter().all(|key| matches!(*key, "PK" | "FK" | "UK")) {
        return Err(ParseError::Unsupported);
    }
    let mut display = format!("{kind} {name}");
    if !keys.is_empty() {
        display += &format!(" {}", keys.join(", "));
    }
    text(&display)
}

pub(super) fn parse(lines: &[String]) -> Result<Diagram, ParseError> {
    let mut nodes: Vec<Vertex> = vec![];
    let mut edges = vec![];
    let mut lr = false;
    let mut lines = lines.iter().map(String::as_str);
    while let Some(line) = lines.next() {
        if let Some(direction) = line.strip_prefix("direction ") {
            lr = match direction.trim() {
                "LR" | "RL" => true,
                "TB" | "BT" | "TD" => false,
                _ => return Err(ParseError::Unsupported),
            };
            continue;
        }
        // Styling and accessibility text change nothing that is drawn here.
        if [
            "classDef ",
            "style ",
            "class ",
            "accTitle",
            "accDescr",
            "title ",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix))
        {
            continue;
        }
        let (first, rest) = name(line)?;
        match rest {
            "" | "{}" | "{ }" => {
                entity(&mut nodes, first)?;
                continue;
            }
            "{" => {
                let index = entity(&mut nodes, first)?;
                if nodes[index].sections.is_empty() {
                    nodes[index].sections.push(vec![]);
                }
                loop {
                    match lines.next() {
                        Some("}") => break,
                        Some(line) => {
                            let section = &mut nodes[index].sections[0];
                            if section.len() >= LIMIT {
                                return Err(ParseError::Limit);
                            }
                            section.push(attribute(line)?);
                        }
                        None => return Err(ParseError::Unsupported),
                    }
                }
                continue;
            }
            _ => {}
        }
        let (left, rest) = LEFT
            .iter()
            .find_map(|&(token, mark)| Some((mark, rest.strip_prefix(token)?)))
            .ok_or(ParseError::Unsupported)?;
        let (dashed, rest) = if let Some(rest) = rest.strip_prefix("--") {
            (false, rest)
        } else if let Some(rest) = rest.strip_prefix("..") {
            (true, rest)
        } else {
            return Err(ParseError::Unsupported);
        };
        let (right, rest) = RIGHT
            .iter()
            .find_map(|&(token, mark)| Some((mark, rest.strip_prefix(token)?)))
            .ok_or(ParseError::Unsupported)?;
        let (second, rest) = name(rest)?;
        let label = match rest.strip_prefix(':') {
            Some(label) => match quoted(label) {
                Some((value, "")) if value.trim().is_empty() => String::new(),
                Some((value, "")) => text(value)?,
                Some(_) => return Err(ParseError::Unsupported),
                None if label.trim().is_empty() => String::new(),
                None => text(label)?,
            },
            None if rest.is_empty() => String::new(),
            None => return Err(ParseError::Unsupported),
        };
        let from = entity(&mut nodes, first)?;
        let to = entity(&mut nodes, second)?;
        if edges.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        edges.push(Edge {
            from,
            to,
            label,
            dashed,
            marks: [left, right],
            ..Default::default()
        });
    }
    if nodes.is_empty() {
        return Err(ParseError::Unsupported);
    }
    Ok(Diagram::Flow { lr, nodes, edges })
}
