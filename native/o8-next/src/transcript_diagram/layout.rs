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
                ..Default::default()
            });
        }
    }
    fn stroke(&mut self, points: Vec<(f32, f32)>, dashed: bool, arrow: bool, marks: [Marker; 2]) {
        self.strokes.push(Stroke {
            points,
            dashed,
            arrow,
            marks,
            gap: None,
        });
    }
    fn fit(mut self, width: f32) -> Self {
        let scale = (width.max(1.) / self.width.max(1.)).min(1.);
        let offset = (width - self.width * scale).max(0.) / 2.;
        for rect in self
            .boxes
            .iter_mut()
            .chain(self.labels.iter_mut().map(|label| &mut label.rect))
            .chain(self.swatches.iter_mut().map(|swatch| &mut swatch.0))
            .chain(
                self.strokes
                    .iter_mut()
                    .filter_map(|stroke| stroke.gap.as_mut()),
            )
        {
            rect.x = rect.x * scale + offset;
            rect.y *= scale;
            rect.w *= scale;
            rect.h *= scale;
        }
        for (x, y) in self
            .strokes
            .iter_mut()
            .flat_map(|stroke| stroke.points.iter_mut())
            .chain(self.rules.iter_mut().flatten())
        {
            *x = *x * scale + offset;
            *y *= scale;
        }
        for wedge in &mut self.wedges {
            wedge.cx = wedge.cx * scale + offset;
            wedge.cy *= scale;
            wedge.r *= scale;
        }
        self.width = width.max(1.);
        self.height *= scale;
        self.scale = scale;
        self
    }
}
// A compartment row, and the band a title takes when compartments follow it.
const ROW: f32 = 18.;
const TITLE: f32 = 16.;
const EMPTY_SECTION: f32 = 10.;
fn compartments(node: &Vertex) -> bool {
    !node.sections.is_empty() || !node.above.is_empty()
}
fn section_height(lines: &[String]) -> f32 {
    if lines.is_empty() {
        EMPTY_SECTION
    } else {
        lines.len() as f32 * ROW + 12.
    }
}
fn node_size(node: &Vertex) -> (f32, f32) {
    use super::state::{CHOICE, END, START};
    if compartments(node) {
        let widest = std::iter::once(&node.label)
            .chain(&node.above)
            .chain(node.sections.iter().flatten())
            .map(|text| text.chars().count())
            .max()
            .unwrap_or(0);
        let height = TITLE
            + (node.above.len() + 1) as f32 * ROW
            + node.sections.iter().map(|s| section_height(s)).sum::<f32>();
        return ((widest as f32 * 7. + 32.).clamp(100., 360.), height);
    }
    let width = (node.label.chars().count() as f32 * 7. + 40.).clamp(100., 320.);
    match node.shape {
        Shape::Circle | Shape::DoubleCircle => (width, width),
        Shape::Diamond => (width * 1.4, 88.),
        Shape::Start => (START, START),
        Shape::End => (END, END),
        Shape::Choice => (CHOICE, CHOICE),
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
        Shape::Diamond | Shape::Choice => rect.h / 2. * t.abs(),
        Shape::Circle | Shape::DoubleCircle | Shape::Start | Shape::End => {
            rect.h / 2. * (1. - (1. - t * t).sqrt())
        }
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
/// A title band, then each compartment under a rule. Class members read
/// left to right; state descriptions stay centred.
fn compartment_labels(scene: &mut Scene, node: &Vertex, rect: BoxRect) {
    let left = node.shape == Shape::Class;
    let mut y = rect.y + TITLE / 2.;
    for line in node.above.iter().chain([&node.label]) {
        scene.label(
            line,
            BoxRect {
                x: rect.x + 12.,
                y,
                w: rect.w - 24.,
                h: ROW,
            },
            false,
        );
        y += ROW;
    }
    y += TITLE / 2.;
    for section in &node.sections {
        scene.rules.push([(rect.x, y), (rect.x + rect.w, y)]);
        let mut row = y + 6.;
        for line in section {
            scene.label(
                line,
                BoxRect {
                    x: rect.x + 12.,
                    y: row,
                    w: rect.w - 24.,
                    h: ROW,
                },
                false,
            );
            if let Some(label) = scene.labels.last_mut() {
                label.left = left;
            }
            row += ROW;
        }
        y += section_height(section);
    }
}
pub(super) fn overlap(a: BoxRect, b: BoxRect) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
/// The part of segment `a`–`b` inside `rect`, as a parameter range along it.
pub(super) fn clip(rect: BoxRect, a: (f32, f32), b: (f32, f32)) -> Option<(f32, f32)> {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let (mut t0, mut t1) = (0f32, 1f32);
    for (p, q) in [
        (-dx, a.0 - rect.x),
        (dx, rect.x + rect.w - a.0),
        (-dy, a.1 - rect.y),
        (dy, rect.y + rect.h - a.1),
    ] {
        if p == 0. {
            if q < 0. {
                return None;
            }
        } else {
            let t = q / p;
            if p < 0. {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
        }
    }
    (t0 < t1).then_some((t0, t1))
}
/// Whether a segment passes through the inside of `rect`, not just along its rim.
pub(super) fn crosses(rect: BoxRect, a: (f32, f32), b: (f32, f32)) -> bool {
    let inner = BoxRect {
        x: rect.x + 0.5,
        y: rect.y + 0.5,
        w: rect.w - 1.,
        h: rect.h - 1.,
    };
    clip(inner, a, b).is_some()
}
impl Stroke {
    /// The polylines to draw: the route with its label plate cut out.
    pub(super) fn pieces(&self) -> Vec<Vec<(f32, f32)>> {
        let Some(gap) = self.gap else {
            return vec![self.points.clone()];
        };
        let mut pieces = vec![];
        let mut piece = vec![];
        for pair in self.points.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let at = |t: f32| (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
            if piece.is_empty() {
                piece.push(a);
            }
            match clip(gap, a, b) {
                Some((t0, t1)) => {
                    if t0 > 0. {
                        piece.push(at(t0));
                    }
                    if piece.len() > 1 {
                        pieces.push(std::mem::take(&mut piece));
                    }
                    piece.clear();
                    if t1 < 1. {
                        piece.extend([at(t1), b]);
                    }
                }
                None => piece.push(b),
            }
        }
        if piece.len() > 1 {
            pieces.push(piece);
        }
        pieces
    }
}
fn point_along(points: &[(f32, f32)], fraction: f32) -> (f32, f32) {
    let length: f32 = points
        .windows(2)
        .map(|p| (p[1].0 - p[0].0).hypot(p[1].1 - p[0].1))
        .sum();
    let mut left = length * fraction;
    for pair in points.windows(2) {
        let step = (pair[1].0 - pair[0].0).hypot(pair[1].1 - pair[0].1);
        if step > 0. && left <= step {
            let t = left / step;
            return (
                pair[0].0 + (pair[1].0 - pair[0].0) * t,
                pair[0].1 + (pair[1].1 - pair[0].1) * t,
            );
        }
        left -= step;
    }
    points[points.len() - 1]
}
/// Places end labels beside their boxes, then each edge label on a plate:
/// centred on its line, which stops at the plate, or beside a return lane.
/// A spot that would cover another edge, a box or a label is passed over.
/// Returns the strokes to cut at their label, with the label's index.
fn edge_labels(scene: &mut Scene, edges: &[Edge], adjacent: &[bool]) -> Vec<(usize, usize)> {
    // A plate that cuts its own line may sit on it; any other spot keeps clear
    // of its own line too.
    let clear = |scene: &Scene, rect: BoxRect, own: usize, cut: bool| {
        rect.x >= 0.
            && rect.y >= 0.
            && scene.boxes.iter().all(|&b| !overlap(rect, b))
            && scene
                .labels
                .iter()
                .filter(|l| l.edge.is_some())
                .all(|l| !overlap(rect, l.rect))
            && scene.strokes.iter().enumerate().all(|(index, stroke)| {
                (index == own && cut)
                    || stroke.points.windows(2).all(|p| !crosses(rect, p[0], p[1]))
            })
    };
    for (index, edge) in edges.iter().enumerate() {
        let points = scene.strokes[index].points.clone();
        for (side, end) in edge.ends.iter().enumerate() {
            if end.is_empty() {
                continue;
            }
            let (tip, next) = if side == 0 {
                (points[0], points[1])
            } else {
                (points[points.len() - 1], points[points.len() - 2])
            };
            let (dx, dy) = (next.0 - tip.0, next.1 - tip.1);
            let length = dx.hypot(dy).max(1.);
            let (ux, uy) = (dx / length, dy / length);
            let (w, h) = (end.chars().count() as f32 * 7. + 8., 18.);
            // Clear of the box along the line, and 8px to one side of it.
            let along = ux.abs() * w / 2. + uy.abs() * h / 2. + 4.;
            let perp = uy.abs() * w / 2. + ux.abs() * h / 2. + 8.;
            let spot = |sign: f32| {
                let (x, y) = (
                    tip.0 + ux * along - uy * perp * sign,
                    tip.1 + uy * along + ux * perp * sign,
                );
                BoxRect {
                    x: x - w / 2.,
                    y: y - h / 2.,
                    w,
                    h,
                }
            };
            let rect = [1., -1.]
                .into_iter()
                .map(spot)
                .find(|&rect| clear(scene, rect, index, false))
                .unwrap_or_else(|| spot(1.));
            scene.labels.push(Label {
                text: end.clone(),
                rect,
                edge: Some(index),
                multiplicity: true,
                ..Default::default()
            });
        }
    }
    let mut gaps = vec![];
    for (index, edge) in edges.iter().enumerate() {
        if edge.label.is_empty() {
            continue;
        }
        let points = scene.strokes[index].points.clone();
        let (w, h) = (
            (edge.label.chars().count() as f32 * 6.5 + 12.).clamp(24., 180.),
            20.,
        );
        let centred: Vec<_> = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]
            .into_iter()
            .map(|fraction| {
                let (x, y) = point_along(&points, fraction);
                (
                    BoxRect {
                        x: x - w / 2.,
                        y: y - h / 2.,
                        w,
                        h,
                    },
                    true,
                )
            })
            .collect();
        let longest = points
            .windows(2)
            .max_by(|a, b| {
                let length = |p: &[(f32, f32)]| (p[1].0 - p[0].0).hypot(p[1].1 - p[0].1);
                length(a).total_cmp(&length(b))
            })
            .map(|p| (p[0], p[1]))
            .unwrap_or((points[0], points[0]));
        let ((ax, ay), (bx, by)) = longest;
        let length = (bx - ax).hypot(by - ay).max(1.);
        let (ux, uy) = ((bx - ax) / length, (by - ay) / length);
        let beside: Vec<_> = [0.5, 0.35, 0.65, 0.2, 0.8]
            .into_iter()
            .flat_map(|t| [(t, 1f32), (t, -1.)])
            .map(|(t, sign)| {
                let perp = uy.abs() * w / 2. + ux.abs() * h / 2. + 6.;
                let (x, y) = (
                    ax + (bx - ax) * t - uy * perp * sign,
                    ay + (by - ay) * t + ux * perp * sign,
                );
                (
                    BoxRect {
                        x: x - w / 2.,
                        y: y - h / 2.,
                        w,
                        h,
                    },
                    false,
                )
            })
            .collect();
        let candidates = if adjacent[index] {
            [centred.clone(), beside].concat()
        } else {
            [beside, centred.clone()].concat()
        };
        let (rect, cut) = candidates
            .into_iter()
            .find(|&(rect, cut)| clear(scene, rect, index, cut))
            .unwrap_or(centred[0]);
        if cut {
            gaps.push((index, scene.labels.len()));
        }
        scene.labels.push(Label {
            text: edge.label.clone(),
            rect,
            background: true,
            edge: Some(index),
            ..Default::default()
        });
    }
    gaps
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
        .enumerate()
        .map(|(index, node)| {
            if node.shape == Shape::Bar {
                // A fork or join spans the flow, long enough for its transitions.
                let degree = edges
                    .iter()
                    .filter(|e| e.from == index || e.to == index)
                    .count();
                return (
                    (40. * degree as f32 + 16.).clamp(72., 320.),
                    super::state::BAR,
                );
            }
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
            let mut room = if edge.label.is_empty() {
                0.
            } else if lr {
                (edge.label.chars().count() as f32 * 7. + 8.).min(96.)
            } else {
                20.
            };
            // End labels sit along the line by their boxes, clear of the middle one.
            for end in edge.ends.iter().filter(|end| !end.is_empty()) {
                room += if lr {
                    end.chars().count() as f32 * 7. + 12.
                } else {
                    22.
                };
            }
            label_room[rank[edge.from]] = label_room[rank[edge.from]].max(room);
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
        if compartments(node) {
            compartment_labels(&mut scene, node, rect);
            continue;
        }
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
        let points = if adjacent[index] {
            let y = channel(rank[edge.from]);
            vec![
                (
                    from,
                    forward_port(a, nodes[edge.from].shape, from, true, lr),
                ),
                (from, y),
                (to, y),
                (to, forward_port(b, nodes[edge.to].shape, to, false, lr)),
            ]
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
            points
        };
        let points: Vec<_> = points.into_iter().map(|p| orient_point(p, lr)).collect();
        scene.stroke(points, edge.dashed, edge.arrow, edge.marks);
    }
    let gaps = edge_labels(&mut scene, edges, &adjacent);
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
    for (stroke, label) in gaps {
        scene.strokes[stroke].gap = Some(scene.labels[label].rect);
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
            [Marker::None; 2],
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
                scene.stroke(points, edge.dashed, edge.arrow, edge.marks);
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
        Diagram::Pie {
            title,
            show_data,
            slices,
        } => super::pie::layout(title, *show_data, slices, width),
    }
    .fit(width)
}
