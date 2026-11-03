use super::*;

const LIMIT: usize = 200;
fn label(text: &str) -> Result<String, ParseError> {
    let text = text.trim();
    let text = if text.starts_with('"') && text.ends_with('"') && text.len() >= 2 {
        &text[1..text.len() - 1]
    } else {
        text
    };
    if text.len() > 512 {
        return Err(ParseError::Limit);
    }
    if text.is_empty() || text.contains(['<', '>', '"']) || text.chars().any(char::is_control) {
        return Err(ParseError::Unsupported);
    }
    Ok(text.to_owned())
}
fn identifier(input: &str) -> Result<(&str, &str), ParseError> {
    let input = input.trim_start();
    let end = input
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .unwrap_or(input.len());
    if end > 512 {
        return Err(ParseError::Limit);
    }
    if end == 0 {
        return Err(ParseError::Unsupported);
    }
    Ok((&input[..end], input[end..].trim_start()))
}
fn vertex<'a>(input: &'a str, nodes: &mut Vec<Vertex>) -> Result<(usize, &'a str), ParseError> {
    let (id, mut rest) = identifier(input)?;
    if matches!(
        id,
        "subgraph" | "end" | "style" | "classDef" | "class" | "click" | "direction"
    ) {
        return Err(ParseError::Unsupported);
    }
    let mut value = None;
    let mut shape = Shape::Rect;
    for (open, close, kind) in [
        ("(((", ")))", Shape::DoubleCircle),
        ("((", "))", Shape::Circle),
        ("([", "])", Shape::Stadium),
        ("[[", "]]", Shape::Subroutine),
        ("[(", ")]", Shape::Cylinder),
        ("{{", "}}", Shape::Hexagon),
        ("[/", "/]", Shape::Slant),
        ("[", "]", Shape::Rect),
        ("(", ")", Shape::Round),
        ("{", "}", Shape::Diamond),
    ] {
        if let Some(tail) = rest.strip_prefix(open) {
            let mut quoted = false;
            let end = tail
                .char_indices()
                .find_map(|(i, c)| {
                    if c == '"' {
                        quoted = !quoted;
                    }
                    (!quoted && tail[i..].starts_with(close)).then_some(i)
                })
                .ok_or(ParseError::Unsupported)?;
            value = Some(label(&tail[..end])?);
            shape = kind;
            rest = tail[end + close.len()..].trim_start();
            break;
        }
    }
    let index = if let Some(index) = nodes.iter().position(|n| n.id == id) {
        index
    } else {
        if nodes.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        nodes.push(Vertex {
            id: id.into(),
            label: id.into(),
            shape: Shape::Rect,
        });
        nodes.len() - 1
    };
    if let Some(value) = value {
        nodes[index].label = value;
        nodes[index].shape = shape;
    }
    Ok((index, rest))
}
fn arrow(input: &str) -> Result<(&str, String, bool, bool), ParseError> {
    if let Some(tail) = input.strip_prefix("-- ") {
        let (text, rest) = tail.split_once("-->").ok_or(ParseError::Unsupported)?;
        return Ok((rest.trim_start(), label(text)?, false, true));
    }
    for (token, dashed, head) in [
        ("-.->", true, true),
        ("-->", false, true),
        ("---", false, false),
        ("==>", false, true),
    ] {
        if let Some(mut rest) = input.strip_prefix(token) {
            rest = rest.trim_start();
            let mut text = String::new();
            if let Some(tail) = rest.strip_prefix('|') {
                let (value, tail) = tail.split_once('|').ok_or(ParseError::Unsupported)?;
                text = label(value)?;
                rest = tail.trim_start();
            }
            return Ok((rest, text, dashed, head));
        }
    }
    Err(ParseError::Unsupported)
}
fn flow(lr: bool, lines: &[String]) -> Result<Diagram, ParseError> {
    let mut nodes = vec![];
    let mut edges = vec![];
    for line in lines {
        let (mut from, mut rest) = vertex(line, &mut nodes)?;
        while !rest.is_empty() {
            let (tail, text, dashed, head) = arrow(rest)?;
            let (to, tail) = vertex(tail, &mut nodes)?;
            if edges.len() >= LIMIT {
                return Err(ParseError::Limit);
            }
            edges.push(Edge {
                from,
                to,
                label: text,
                dashed,
                arrow: head,
            });
            from = to;
            rest = tail;
        }
    }
    if nodes.is_empty() {
        return Err(ParseError::Unsupported);
    }
    Ok(Diagram::Flow { lr, nodes, edges })
}
fn participant(input: &str, participants: &mut Vec<Vertex>) -> Result<usize, ParseError> {
    let (id, rest) = identifier(input)?;
    if !rest.is_empty() {
        return Err(ParseError::Unsupported);
    }
    vertex(id, participants).map(|(index, _)| index)
}
fn sequence(lines: &[String]) -> Result<Diagram, ParseError> {
    let mut participants = vec![];
    let mut events = vec![];
    for line in lines {
        if let Some(tail) = line.strip_prefix("participant ") {
            let (id, alias) = tail
                .split_once(" as ")
                .map_or((tail, None), |(id, alias)| (id, Some(alias)));
            let index = participant(id, &mut participants)?;
            if let Some(alias) = alias {
                participants[index].label = label(alias)?;
            }
            continue;
        }
        if events.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        if let Some(tail) = line
            .strip_prefix("Note ")
            .or_else(|| line.strip_prefix("note "))
        {
            let (position, text) = tail.split_once(':').ok_or(ParseError::Unsupported)?;
            let (ids, side) = if let Some(ids) = position.strip_prefix("over ") {
                (ids, 0)
            } else if let Some(ids) = position.strip_prefix("left of ") {
                (ids, -1)
            } else if let Some(ids) = position.strip_prefix("right of ") {
                (ids, 1)
            } else {
                return Err(ParseError::Unsupported);
            };
            let (from, to) = ids.split_once(',').map_or((ids, ids), |pair| pair);
            if side != 0 && from != to {
                return Err(ParseError::Unsupported);
            }
            let from = participant(from, &mut participants)?;
            let to = participant(to, &mut participants)?;
            events.push(Event::Note {
                from,
                to,
                side,
                label: label(text)?,
            });
            continue;
        }
        let (from, tail) = identifier(line)?;
        let mut message = None;
        for (token, dashed) in [("-->>", true), ("->>", false), ("-->", true), ("->", false)] {
            if let Some(tail) = tail.strip_prefix(token) {
                message = Some((tail, dashed));
                break;
            }
        }
        let (tail, dashed) = message.ok_or(ParseError::Unsupported)?;
        let (to, tail) = identifier(tail)?;
        let text = tail.strip_prefix(':').ok_or(ParseError::Unsupported)?;
        let from = participant(from, &mut participants)?;
        let to = participant(to, &mut participants)?;
        events.push(Event::Message(Edge {
            from,
            to,
            label: label(text)?,
            dashed,
            arrow: true,
        }));
    }
    if participants.is_empty() {
        return Err(ParseError::Unsupported);
    }
    Ok(Diagram::Sequence {
        participants,
        events,
    })
}

pub(super) fn parse(source: &str) -> Result<Diagram, ParseError> {
    if source.len() > 65_536 {
        return Err(ParseError::Limit);
    }
    let mut lines = vec![];
    // Semicolons separate flow statements, except inside labels or quotes.
    let sequence_kind = source.trim_start().starts_with("sequenceDiagram");
    for line in source
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with("%%"))
    {
        let mut depth = 0usize;
        let mut quoted = false;
        let mut start = 0;
        for (index, c) in line.char_indices() {
            if c == '"' {
                quoted = !quoted;
            }
            if !quoted {
                if matches!(c, '[' | '(' | '{') {
                    depth += 1;
                }
                if matches!(c, ']' | ')' | '}') {
                    depth = depth.saturating_sub(1);
                }
                if c == ';' && depth == 0 && !sequence_kind {
                    let statement = line[start..index].trim();
                    if !statement.is_empty() {
                        lines.push(statement.to_owned());
                    }
                    start = index + 1;
                }
            }
        }
        let tail = line[start..].trim();
        if !tail.is_empty() {
            lines.push(tail.to_owned());
        }
    }
    let (header, body) = lines.split_first().ok_or(ParseError::Unsupported)?;
    match header.as_str() {
        "flowchart TD" | "flowchart TB" | "graph TD" | "graph TB" => flow(false, body),
        "flowchart LR" | "graph LR" => flow(true, body),
        "sequenceDiagram" => sequence(body),
        _ => Err(ParseError::Unsupported),
    }
}
