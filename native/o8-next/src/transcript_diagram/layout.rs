use super::*;

impl BoxRect {
    pub(super) fn center(self) -> (f32, f32) {
        (self.x + self.w / 2., self.y + self.h / 2.)
    }
}
impl Scene {
    fn label(&mut self, text: &str, rect: BoxRect, background: bool) {
        if !text.is_empty() {
            self.labels.push(Label {
                text: text.into(),
                rect,
                background,
            });
        }
    }
    fn stroke(&mut self, points: Vec<(f32, f32)>, dashed: bool, arrow: bool) {
        self.strokes.push(Stroke {
            points,
            dashed,
            arrow,
        });
    }
    fn fit(mut self, width: f32) -> Self {
        let scale = (width.max(1.) / self.width.max(1.)).min(1.);
        let offset = (width - self.width * scale).max(0.) / 2.;
        for rect in self
            .boxes
            .iter_mut()
            .chain(self.labels.iter_mut().map(|label| &mut label.rect))
        {
            rect.x = rect.x * scale + offset;
            rect.y *= scale;
            rect.w *= scale;
            rect.h *= scale;
        }
        for stroke in &mut self.strokes {
            for (x, y) in &mut stroke.points {
                *x = *x * scale + offset;
                *y *= scale;
            }
        }
        self.width = width.max(1.);
        self.height *= scale;
        self.scale = scale;
        self
    }
}
fn node_size(node: &Vertex) -> (f32, f32) {
    let width = (node.label.chars().count() as f32 * 7. + 40.).clamp(100., 320.);
    match node.shape {
        Shape::Circle | Shape::DoubleCircle => (width, width),
        Shape::Diamond => (width * 1.4, 88.),
        _ => (width, 52.),
    }
}
// Each rail has its own coordinate. Crossings can meet at a point, but routes
// cannot run on top of one another. The small step also fits high-degree ports.
fn rail(used: &mut std::collections::HashSet<u32>, mut value: f32) -> f32 {
    while !used.insert(value.to_bits()) {
        value += 1. / 64.;
    }
    value
}
fn clear_side(boxes: &[BoxRect], right: f32, y: f32) -> bool {
    boxes
        .iter()
        .all(|r| y <= r.y || y >= r.y + r.h || r.x + r.w <= right)
}
fn orient_box(rect: BoxRect, lr: bool) -> BoxRect {
    if lr {
        BoxRect {
            x: rect.y,
            y: rect.x,
            w: rect.h,
            h: rect.w,
        }
    } else {
        rect
    }
}
fn orient_point((x, y): (f32, f32), lr: bool) -> (f32, f32) {
    if lr { (y, x) } else { (x, y) }
}
fn port(start: f32, length: f32, slot: &mut usize, count: usize) -> f32 {
    *slot += 1;
    start + length * (0.25 + 0.5 * *slot as f32 / (count + 1) as f32)
}
fn forward_port(rect: BoxRect, shape: Shape, cross: f32, bottom: bool, lr: bool) -> f32 {
    let t = ((cross - rect.x - rect.w / 2.) / (rect.w / 2.)).clamp(-1., 1.);
    let inset = match shape {
        Shape::Diamond => rect.h / 2. * t.abs(),
        Shape::Circle | Shape::DoubleCircle => rect.h / 2. * (1. - (1. - t * t).sqrt()),
        Shape::Hexagon if lr => rect.h * 0.15 * t.abs(),
        Shape::Slant if lr => rect.h * 0.15 * if bottom { (1. + t) / 2. } else { (1. - t) / 2. },
        Shape::Cylinder if !lr => (rect.h * 0.12).min(6.) * (1. - (1. - t * t).sqrt()),
        Shape::Round | Shape::Stadium => {
            let radius = if shape == Shape::Round {
                8f32.min(rect.w.min(rect.h) / 2.)
            } else {
                rect.w.min(rect.h) / 2.
            };
            let dx = (radius - (cross - rect.x).min(rect.x + rect.w - cross)).max(0.);
            radius - (radius * radius - dx * dx).max(0.).sqrt()
        }
        _ => 0.,
    };
    if bottom {
        rect.y + rect.h - inset
    } else {
        rect.y + inset
    }
}
fn flow(lr: bool, nodes: &[Vertex], edges: &[Edge]) -> Scene {
    let mut scene = Scene::default();
    // Remove each vertex once. A cycle starts a new layer when no root remains.
    let mut degree = vec![0usize; nodes.len()];
    for edge in edges {
        degree[edge.to] += 1;
    }
    let mut rank = vec![0usize; nodes.len()];
    let mut placed = vec![false; nodes.len()];
    for _ in nodes {
        let next = (0..nodes.len())
            .find(|&i| !placed[i] && degree[i] == 0)
            .or_else(|| (0..nodes.len()).find(|&i| !placed[i]));
        let Some(next) = next else {
            break;
        };
        placed[next] = true;
        for edge in edges.iter().filter(|e| e.from == next && !placed[e.to]) {
            degree[edge.to] = degree[edge.to].saturating_sub(1);
            rank[edge.to] = rank[edge.to].max(rank[next] + 1);
        }
    }
    // Work top-to-bottom, then transpose the geometry for horizontal graphs.
    let dimensions: Vec<_> = nodes
        .iter()
        .map(|node| {
            let (w, h) = node_size(node);
            if lr { (h, w) } else { (w, h) }
        })
        .collect();
    let layers = rank.iter().copied().max().unwrap_or(0) + 1;
    let mut counts = vec![0usize; layers];
    let mut heights = vec![0f32; layers];
    for (index, &rank) in rank.iter().enumerate() {
        counts[rank] += 1;
        heights[rank] = heights[rank].max(dimensions[index].1);
    }
    let adjacent: Vec<_> = edges
        .iter()
        .map(|e| rank[e.to] == rank[e.from] + 1)
        .collect();
    let mut label_room = vec![0f32; layers];
    let mut channels = vec![0usize; layers];
    let mut outgoing = vec![0usize; nodes.len()];
    let mut incoming = vec![0usize; nodes.len()];
    let mut sideways = vec![0usize; nodes.len()];
    for (edge, &adjacent) in edges.iter().zip(&adjacent) {
        channels[rank[edge.from]] += 1;
        if adjacent {
            outgoing[edge.from] += 1;
            incoming[edge.to] += 1;
            if !edge.label.is_empty() {
                let room = if lr {
                    (edge.label.chars().count() as f32 * 7. + 8.).min(96.)
                } else {
                    20.
                };
                label_room[rank[edge.from]] = label_room[rank[edge.from]].max(room);
            }
        } else {
            sideways[edge.from] += 1;
            sideways[edge.to] += 1;
            channels[rank[edge.to]] += 1;
        }
    }
    let gaps: Vec<_> = label_room.iter().map(|room| 40. + room).collect();
    let mut tops = vec![24f32; layers];
    for layer in 1..layers {
        tops[layer] = tops[layer - 1] + heights[layer - 1] + gaps[layer - 1];
    }
    let cell_w = dimensions.iter().map(|s| s.0).fold(0f32, f32::max);
    let cross = cell_w + 48.;
    let max_count = counts.iter().copied().max().unwrap_or(1) as f32;
    let mut slots = vec![0usize; layers];
    let mut boxes = Vec::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        let layer = rank[index];
        let (w, h) = dimensions[index];
        let rect = BoxRect {
            x: 24.
                + (max_count - counts[layer] as f32) * cross / 2.
                + slots[layer] as f32 * cross
                + (cell_w - w) / 2.,
            y: tops[layer] + (heights[layer] - h) / 2.,
            w,
            h,
        };
        slots[layer] += 1;
        boxes.push(rect);
        let rect = orient_box(rect, lr);
        scene.boxes.push(rect);
        scene.shapes.push(node.shape);
        let inset = if node.shape == Shape::Diamond {
            0.25
        } else {
            0.12
        };
        scene.label(
            &node.label,
            BoxRect {
                x: rect.x + rect.w * inset,
                y: rect.y + rect.h * 0.2,
                w: rect.w * (1. - 2. * inset),
                h: rect.h * 0.6,
            },
            false,
        );
    }
    let mut used_cross = std::collections::HashSet::new();
    let mut used_side = std::collections::HashSet::new();
    let mut out_slot = vec![0usize; nodes.len()];
    let mut in_slot = vec![0usize; nodes.len()];
    let mut side_slot = vec![0usize; nodes.len()];
    let mut ports = Vec::with_capacity(edges.len());
    // Allocate forward ports first so outside stubs cannot coincide with them.
    for (edge, &adjacent) in edges.iter().zip(&adjacent) {
        let a = boxes[edge.from];
        let b = boxes[edge.to];
        if adjacent {
            ports.push((
                rail(
                    &mut used_cross,
                    port(a.x, a.w, &mut out_slot[edge.from], outgoing[edge.from]),
                ),
                rail(
                    &mut used_cross,
                    port(b.x, b.w, &mut in_slot[edge.to], incoming[edge.to]),
                ),
            ));
        } else {
            ports.push((
                rail(
                    &mut used_side,
                    port(a.y, a.h, &mut side_slot[edge.from], sideways[edge.from]),
                ),
                rail(
                    &mut used_side,
                    port(b.y, b.h, &mut side_slot[edge.to], sideways[edge.to]),
                ),
            ));
        }
    }
    let mut channel_slot = vec![0usize; layers];
    let mut channel = |layer: usize| {
        channel_slot[layer] += 1;
        let start = if label_room[layer] > 0. { 24. } else { 8. };
        tops[layer]
            + heights[layer]
            + start
            + (gaps[layer] - start - 8.) * channel_slot[layer] as f32 / (channels[layer] + 1) as f32
    };
    let outside = boxes.iter().map(|r| r.x + r.w).fold(0f32, f32::max) + 48.;
    let mut lane = 0;
    for (index, edge) in edges.iter().enumerate() {
        let a = boxes[edge.from];
        let b = boxes[edge.to];
        let (from, to) = ports[index];
        let (points, middle) = if adjacent[index] {
            let y = channel(rank[edge.from]);
            (
                vec![
                    (
                        from,
                        forward_port(a, nodes[edge.from].shape, from, true, lr),
                    ),
                    (from, y),
                    (to, y),
                    (to, forward_port(b, nodes[edge.to].shape, to, false, lr)),
                ],
                ((from + to) / 2., y),
            )
        } else {
            let x = outside + lane as f32 * 16.;
            lane += 1;
            let mut points = vec![(a.x + a.w, from)];
            // A clear side exit goes straight to the lane. A node with a peer
            // in the way first uses the gutter beside its own box and rank.
            let source_y = if clear_side(&boxes, a.x + a.w, from) {
                from
            } else {
                let stub = rail(&mut used_cross, a.x + a.w + 8.);
                let y = channel(rank[edge.from]);
                points.extend([(stub, from), (stub, y)]);
                y
            };
            let target_y = if clear_side(&boxes, b.x + b.w, to) {
                to
            } else {
                channel(rank[edge.to])
            };
            points.extend([(x, source_y), (x, target_y)]);
            if target_y != to {
                let stub = rail(&mut used_cross, b.x + b.w + 8.);
                points.extend([(stub, target_y), (stub, to)]);
            }
            points.push((b.x + b.w, to));
            (points, (x, (source_y + target_y) / 2.))
        };
        let (x, y) = orient_point(middle, lr);
        scene.label(
            &edge.label,
            BoxRect {
                x: x - 48.,
                y: y - 22.,
                w: 96.,
                h: 20.,
            },
            true,
        );
        scene.stroke(
            points.into_iter().map(|p| orient_point(p, lr)).collect(),
            edge.dashed,
            edge.arrow,
        );
    }
    // Fit actual node, route and label extents, with the normal outer padding.
    scene.width = scene
        .boxes
        .iter()
        .map(|r| r.x + r.w)
        .chain(
            scene
                .strokes
                .iter()
                .flat_map(|s| s.points.iter().map(|p| p.0)),
        )
        .chain(scene.labels.iter().map(|l| l.rect.x + l.rect.w))
        .fold(0f32, f32::max)
        + 24.;
    scene.height = scene
        .boxes
        .iter()
        .map(|r| r.y + r.h)
        .chain(
            scene
                .strokes
                .iter()
                .flat_map(|s| s.points.iter().map(|p| p.1)),
        )
        .chain(scene.labels.iter().map(|l| l.rect.y + l.rect.h))
        .fold(0f32, f32::max)
        + 24.;
    for label in &mut scene.labels {
        label.rect.x = label
            .rect
            .x
            .clamp(4., (scene.width - label.rect.w - 4.).max(4.));
    }
    scene
}

fn sequence(participants: &[Vertex], events: &[Event]) -> Scene {
    let mut scene = Scene::default();
    let lane = participants
        .iter()
        .map(node_size)
        .map(|s| s.0)
        .fold(180f32, f32::max)
        + 40.;
    let margin = 180.;
    let height = 112. + events.len() as f32 * 80.;
    scene.width = margin * 2. + participants.len() as f32 * lane;
    scene.height = height;
    for (index, participant) in participants.iter().enumerate() {
        let x = margin + index as f32 * lane;
        let rect = BoxRect {
            x: x + 10.,
            y: 12.,
            w: lane - 20.,
            h: 44.,
        };
        scene.boxes.push(rect);
        scene.shapes.push(Shape::Rect);
        scene.label(
            &participant.label,
            BoxRect {
                x: rect.x + 8.,
                y: rect.y,
                w: rect.w - 16.,
                h: rect.h,
            },
            false,
        );
        scene.stroke(
            vec![(x + lane / 2., 56.), (x + lane / 2., height - 12.)],
            true,
            false,
        );
    }
    for (index, event) in events.iter().enumerate() {
        let y = 96. + index as f32 * 80.;
        let center = |index: usize| margin + index as f32 * lane + lane / 2.;
        match event {
            Event::Message(edge) => {
                let from = center(edge.from);
                let to = center(edge.to);
                let points = if edge.from == edge.to {
                    vec![
                        (from, y),
                        (from + 40., y),
                        (from + 40., y + 24.),
                        (from, y + 24.),
                    ]
                } else {
                    vec![(from, y), (to, y)]
                };
                let (x, w) = if from == to {
                    (from + 8., lane / 2. - 16.)
                } else {
                    (from.min(to) + 8., (to - from).abs() - 16.)
                };
                scene.label(
                    &edge.label,
                    BoxRect {
                        x,
                        y: y - 26.,
                        w,
                        h: 22.,
                    },
                    true,
                );
                scene.stroke(points, edge.dashed, edge.arrow);
            }
            Event::Note {
                from,
                to,
                side,
                label,
            } => {
                let (a, b) = (center(*from), center(*to));
                let w = if from == to {
                    lane - 28.
                } else {
                    (b - a).abs() + lane / 2.
                };
                let x = match side {
                    -1 => a - w - 12.,
                    1 => a + 12.,
                    _ => (a + b - w) / 2.,
                };
                let rect = BoxRect {
                    x,
                    y: y - 24.,
                    w,
                    h: 48.,
                };
                scene.boxes.push(rect);
                scene.shapes.push(Shape::Note);
                scene.label(
                    label,
                    BoxRect {
                        x: x + 10.,
                        y: y - 24.,
                        w: w - 20.,
                        h: 48.,
                    },
                    false,
                );
            }
        }
    }
    scene
}
pub(super) fn layout(diagram: &Diagram, width: f32) -> Scene {
    match diagram {
        Diagram::Flow { lr, nodes, edges } => flow(*lr, nodes, edges),
        Diagram::Sequence {
            participants,
            events,
        } => sequence(participants, events),
    }
    .fit(width)
}
