// Mind maps: `mindmap`.
//
// Ported from Pele (https://github.com/obsidianmd/pele), MIT License,
// Copyright (c) 2026 kepano and the Pele contributors.
// Upstream paths: src/diagrams/mindmap/parser.ts, db.ts and render.ts, and
// src/diagrams/common/outline.ts, at commit
// 3a2f075ee0c3d914f0fad3545fc0f193693975ac.
// The indentation rule (a node's parent is the last node indented less), the
// single root, the node shapes, the branch colors from the first level and
// the branches spreading to both sides of the root follow it. Icons and
// classes are not drawn. See NOTICE.md and licenses/pele-MIT.txt.
use super::{
    parse::{LIMIT, text},
    *,
};

const PAD: f32 = 8.;
const HEIGHT: f32 = 32.;
const GAP_X: f32 = 36.;
const GAP_Y: f32 = 8.;
const BRANCH_GAP_X: f32 = 52.;
const TEXT: f32 = 12.;

/// Upstream's delimiters, longest first. Clouds and bangs draw rounded.
const SHAPES: [(&str, &str, Shape); 6] = [
    ("((", "))", Shape::Circle),
    ("))", "((", Shape::Round),
    ("{{", "}}", Shape::Hexagon),
    ("(", ")", Shape::Round),
    (")", "(", Shape::Round),
    ("[", "]", Shape::Rect),
];

fn node(input: &str) -> Result<Vertex, ParseError> {
    for (open, close, shape) in SHAPES {
        if let Some(at) = input.find(open)
            && input.len() >= at + open.len() + close.len()
            && input.ends_with(close)
        {
            let id = input[..at].trim();
            if !id
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
            {
                continue;
            }
            let inner = input[at + open.len()..input.len() - close.len()].trim();
            let inner = inner
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or(inner);
            let inner = inner
                .strip_prefix('`')
                .and_then(|s| s.strip_suffix('`'))
                .unwrap_or(inner);
            return Ok(Vertex {
                id: id.into(),
                label: text(inner)?,
                shape,
                ..Default::default()
            });
        }
    }
    Ok(Vertex {
        label: text(input)?,
        shape: Shape::Stadium,
        ..Default::default()
    })
}

/// Reads the source's own lines, since indentation is the structure.
pub(super) fn parse(source: &str) -> Result<Diagram, ParseError> {
    let mut nodes: Vec<Vertex> = vec![];
    let mut parents: Vec<Option<usize>> = vec![];
    let mut levels: Vec<usize> = vec![];
    // The chain of nodes that can still take children, by increasing indent.
    let mut open: Vec<usize> = vec![];
    let mut header = false;
    for line in source.lines() {
        let content = line.trim();
        if content.is_empty() || content.starts_with("%%") {
            continue;
        }
        if !header {
            if content != "mindmap" {
                return Err(ParseError::Unsupported);
            }
            header = true;
            continue;
        }
        if content.starts_with("::icon(") || content.starts_with(":::") {
            continue;
        }
        let level = line.len() - line.trim_start().len();
        if nodes.len() >= LIMIT {
            return Err(ParseError::Limit);
        }
        while open.last().is_some_and(|&i| levels[i] >= level) {
            open.pop();
        }
        let parent = open.last().copied();
        if parent.is_none() && !nodes.is_empty() {
            return Err(ParseError::Unsupported);
        }
        let mut vertex = node(content)?;
        // Plain text is a pill at the root and rounded below it.
        if !nodes.is_empty() && vertex.shape == Shape::Stadium {
            vertex.shape = Shape::Round;
        }
        nodes.push(vertex);
        parents.push(parent);
        levels.push(level);
        open.push(nodes.len() - 1);
    }
    if nodes.is_empty() {
        return Err(ParseError::Unsupported);
    }
    Ok(Diagram::Mindmap { nodes, parents })
}

fn size(node: &Vertex) -> (f32, f32) {
    let w = (node.label.chars().count() as f32 * TEXT * 0.6 + 28.).clamp(48., 220.);
    if node.shape == Shape::Circle {
        let d = w.max(HEIGHT);
        (d, d)
    } else {
        (w, HEIGHT)
    }
}

/// The root in the middle, the first half of its branches to the right and
/// the rest to the left, each subtree a column per level.
pub(super) fn layout(nodes: &[Vertex], parents: &[Option<usize>]) -> Scene {
    let mut scene = Scene::default();
    let n = nodes.len();
    let mut children = vec![vec![]; n];
    for (index, parent) in parents.iter().enumerate() {
        if let Some(parent) = *parent {
            children[parent].push(index);
        }
    }
    let sizes: Vec<(f32, f32)> = nodes.iter().map(size).collect();
    // Each first-level branch's color, which its subtree keeps.
    let mut branch = vec![0usize; n];
    for index in 1..n {
        if let Some(parent) = parents[index] {
            branch[index] = if parent == 0 {
                children[0].iter().position(|&c| c == index).unwrap_or(0)
            } else {
                branch[parent]
            };
        }
    }
    let mut depth = vec![0usize; n];
    for index in 1..n {
        if let Some(parent) = parents[index] {
            depth[index] = depth[parent] + 1;
        }
    }
    let split = children[0].len().div_ceil(2);
    let mut side = vec![1f32; n];
    for (order, &child) in children[0].iter().enumerate() {
        if order >= split {
            side[child] = -1.;
        }
    }
    for index in 1..n {
        if let Some(parent) = parents[index]
            && parent != 0
        {
            side[index] = side[parent];
        }
    }
    // The widest node at each depth on each side sets that column.
    let levels = depth.iter().copied().max().unwrap_or(0) + 1;
    let mut column = [vec![0f32; levels], vec![0f32; levels]];
    for index in 1..n {
        let s = usize::from(side[index] < 0.);
        column[s][depth[index]] = column[s][depth[index]].max(sizes[index].0);
    }
    // Leaves stack down each side; a parent sits midway along its children.
    let mut y = vec![0f32; n];
    let mut x = vec![0f32; n];
    let mut height = [0f32; 2];
    fn place(
        index: usize,
        children: &[Vec<usize>],
        sizes: &[(f32, f32)],
        y: &mut [f32],
        cursor: &mut f32,
    ) {
        if children[index].is_empty() {
            y[index] = *cursor + sizes[index].1 / 2.;
            *cursor += sizes[index].1 + GAP_Y;
            return;
        }
        let top = *cursor;
        for &child in &children[index] {
            place(child, children, sizes, y, cursor);
        }
        let (first, last) = (
            children[index][0],
            children[index][children[index].len() - 1],
        );
        y[index] = (y[first] + y[last]) / 2.;
        // A parent taller than its children moves the subtree down to clear
        // what came before it.
        let over = top - (y[index] - sizes[index].1 / 2.);
        if over > 0. {
            fn shift(index: usize, children: &[Vec<usize>], y: &mut [f32], by: f32) {
                y[index] += by;
                for &child in &children[index] {
                    shift(child, children, y, by);
                }
            }
            shift(index, children, y, over);
            *cursor += over;
        }
        if sizes[index].1 > y[last] - y[first] + sizes[first].1 {
            *cursor = cursor.max(y[index] + sizes[index].1 / 2. + GAP_Y);
        }
    }
    for (s, sign) in [(0, 1f32), (1, -1f32)] {
        let mut cursor = 0f32;
        for &child in children[0].iter().filter(|&&c| side[c] == sign) {
            place(child, &children, &sizes, &mut y, &mut cursor);
            cursor += GAP_Y;
        }
        height[s] = (cursor - 2. * GAP_Y).max(0.);
    }
    let total = height[0].max(height[1]).max(sizes[0].1);
    // Center each side on the root.
    for index in 1..n {
        let s = usize::from(side[index] < 0.);
        y[index] += (total - height[s]) / 2.;
    }
    y[0] = total / 2.;
    let reach = |s: usize| -> f32 {
        (1..levels)
            .map(|d| column[s][d])
            .filter(|w| *w > 0.)
            .map(|w| w + GAP_X)
            .sum::<f32>()
            + if column[s].get(1).is_some_and(|w| *w > 0.) {
                BRANCH_GAP_X - GAP_X
            } else {
                0.
            }
    };
    let left_reach = reach(1);
    let root_x = PAD + left_reach + sizes[0].0 / 2.;
    x[0] = root_x;
    for index in 1..n {
        let s = usize::from(side[index] < 0.);
        let inner: f32 = column[s][1..depth[index]].iter().map(|w| w + GAP_X).sum();
        let offset = sizes[0].0 / 2. + BRANCH_GAP_X + inner + column[s][depth[index]] / 2.;
        x[index] = root_x + side[index] * offset;
    }
    let rect = |index: usize| BoxRect {
        x: x[index] - sizes[index].0 / 2.,
        y: PAD + y[index] - sizes[index].1 / 2.,
        w: sizes[index].0,
        h: sizes[index].1,
    };
    for index in 1..n {
        let Some(parent) = parents[index] else {
            continue;
        };
        let (from, to) = (rect(parent), rect(index));
        let sign = side[index];
        let start = (
            from.x + from.w / 2. + sign * from.w / 2.,
            from.y + from.h / 2.,
        );
        let end = (to.x + to.w / 2. - sign * to.w / 2., to.y + to.h / 2.);
        let bend = end.0 - sign * GAP_X / 2.;
        scene.strokes.push(Stroke {
            points: vec![start, (bend, start.1), (bend, end.1), end],
            dashed: false,
            arrow: false,
            marks: [Marker::None; 2],
            gap: None,
            color: Some(branch[index]),
        });
    }
    for (index, node) in nodes.iter().enumerate() {
        let r = rect(index);
        scene.boxes.push(r);
        scene.shapes.push(node.shape);
        scene.labels.push(Label {
            text: node.label.clone(),
            rect: BoxRect {
                x: r.x + 8.,
                y: r.y,
                w: r.w - 16.,
                h: r.h,
            },
            ..Default::default()
        });
    }
    scene.width = PAD * 2. + left_reach + sizes[0].0 + reach(0);
    scene.height = PAD * 2. + total;
    scene
}
