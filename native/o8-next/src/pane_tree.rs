//! The workspace's split panes, as classic's tile tree (src/lib/tiles): a
//! binary tree whose leaves are panes. The main pane shows the active header
//! tab; every other pane holds its own chat or terminal. Dropping a rail
//! button on a pane splits that pane at the edge it was dropped nearest.
use serde::{Deserialize, Serialize};

/// The main pane's id; it is never closed.
pub const MAIN: &str = "main";
/// TileContainer's MIN/MAX_SPLIT_RATIO.
const MIN_RATIO: f32 = 0.15;
const MAX_RATIO: f32 = 0.85;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Leaf {
    Main,
    Chat { session: String },
    Terminal {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<String>,
    },
    /// One worker's card in the automatic grid.
    Worker { agent: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Node {
    Leaf {
        id: String,
        content: Leaf,
    },
    Split {
        id: String,
        /// Side by side (classic's 'vertical'); otherwise stacked.
        vertical: bool,
        ratio: f32,
        children: Box<[Node; 2]>,
    },
}

/// Where a drop lands on a pane (workspaceTabDropZone).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Zone {
    Left,
    Right,
    Above,
    Below,
    Center,
}

impl Zone {
    /// The nearest edge within 28% of the pane, else the center.
    pub fn at(x: f32, y: f32) -> Zone {
        let (x, y) = (x.clamp(0., 1.), y.clamp(0., 1.));
        let edges = [
            (Zone::Left, x),
            (Zone::Right, 1. - x),
            (Zone::Above, y),
            (Zone::Below, 1. - y),
        ];
        let (zone, distance) = edges
            .into_iter()
            .fold(edges[0], |best, edge| if edge.1 < best.1 { edge } else { best });
        if distance < 0.28 { zone } else { Zone::Center }
    }
    /// TileContainer's overlay label.
    pub fn label(self) -> &'static str {
        match self {
            Zone::Left => "Open left",
            Zone::Right => "Open right",
            Zone::Above => "Open above",
            Zone::Below => "Open below",
            Zone::Center => "Open beside this pane",
        }
    }
    /// Side by side, and whether the new pane goes first. The center opens
    /// beside, as classic's handlePaneDrop does.
    pub fn split(self) -> (bool, bool) {
        match self {
            Zone::Left => (true, true),
            Zone::Right | Zone::Center => (true, false),
            Zone::Above => (false, true),
            Zone::Below => (false, false),
        }
    }
}

impl Node {
    pub fn main() -> Node {
        Node::Leaf {
            id: MAIN.into(),
            content: Leaf::Main,
        }
    }
    pub fn id(&self) -> &str {
        match self {
            Node::Leaf { id, .. } | Node::Split { id, .. } => id,
        }
    }
    pub fn leaves(&self) -> Vec<(&str, &Leaf)> {
        match self {
            Node::Leaf { id, content } => vec![(id, content)],
            Node::Split { children, .. } => {
                let mut all = children[0].leaves();
                all.extend(children[1].leaves());
                all
            }
        }
    }
    pub fn leaf_mut(&mut self, target: &str) -> Option<&mut Leaf> {
        match self {
            Node::Leaf { id, content } => (id == target).then_some(content),
            Node::Split { children, .. } => {
                let [first, second] = &mut **children;
                first.leaf_mut(target).or_else(|| second.leaf_mut(target))
            }
        }
    }
    /// splitTile with exact placement: `target` becomes a split of itself
    /// and `leaf`, half each. False when no pane has that id.
    pub fn split(&mut self, target: &str, zone: Zone, new_id: String, leaf: Leaf) -> bool {
        // A moved pane splits again under its own id, so its split's id may
        // still be taken by the split it left.
        let mut taken = vec![];
        self.ids(&mut taken);
        let split = std::iter::once(format!("split-{new_id}"))
            .chain((2..).map(|n| format!("split-{new_id}-{n}")))
            .find(|id| !taken.contains(id))
            .unwrap();
        self.split_as(target, zone, new_id, leaf, &split)
    }
    fn ids(&self, out: &mut Vec<String>) {
        match self {
            Node::Leaf { id, .. } => out.push(id.clone()),
            Node::Split { id, children, .. } => {
                out.push(id.clone());
                children.iter().for_each(|child| child.ids(out));
            }
        }
    }
    fn split_as(
        &mut self,
        target: &str,
        zone: Zone,
        new_id: String,
        leaf: Leaf,
        split: &str,
    ) -> bool {
        match self {
            Node::Leaf { id, .. } if id == target => {
                let (vertical, before) = zone.split();
                let current = std::mem::replace(self, Node::main());
                let added = Node::Leaf {
                    id: new_id.clone(),
                    content: leaf,
                };
                let children = if before {
                    [added, current]
                } else {
                    [current, added]
                };
                *self = Node::Split {
                    id: split.to_owned(),
                    vertical,
                    ratio: 0.5,
                    children: Box::new(children),
                };
                true
            }
            Node::Leaf { .. } => false,
            Node::Split { children, .. } => {
                let [first, second] = &mut **children;
                first.split_as(target, zone, new_id.clone(), leaf.clone(), split)
                    || second.split_as(target, zone, new_id, leaf, split)
            }
        }
    }
    /// closeTile: the pane's sibling takes its place. The main pane stays.
    pub fn close(&mut self, target: &str) -> bool {
        if target == MAIN {
            return false;
        }
        let Node::Split { children, .. } = self else {
            return false;
        };
        let index = children
            .iter()
            .position(|child| matches!(child, Node::Leaf { id, .. } if id == target));
        if let Some(index) = index {
            let [first, second] = std::mem::replace(&mut **children, [Node::main(), Node::main()]);
            *self = if index == 0 { second } else { first };
            return true;
        }
        let [first, second] = &mut **children;
        first.close(target) || second.close(target)
    }
    /// resizeTile, clamped as classic clamps it.
    pub fn resize(&mut self, target: &str, value: f32) -> bool {
        match self {
            Node::Leaf { .. } => false,
            Node::Split {
                id,
                ratio,
                children,
                ..
            } => {
                if id == target {
                    *ratio = value.clamp(MIN_RATIO, MAX_RATIO);
                    return true;
                }
                let [first, second] = &mut **children;
                first.resize(target, value) || second.resize(target, value)
            }
        }
    }
    /// rebalanceAutomaticSessionTiles: the main pane keeps one full-height
    /// column and the workers fill the rest in even rows, two columns up to
    /// four workers, three up to eight, then four, and never more than
    /// `max_columns` fit beside the main pane.
    pub fn worker_grid(main: Node, workers: Vec<Node>, max_columns: usize) -> Node {
        let count = workers.len();
        if count == 0 {
            return main;
        }
        let columns = match count {
            ..=4 => 2,
            ..=8 => 3,
            _ => 4,
        }
        .min(max_columns.max(1));
        let rows = count.div_ceil(columns);
        let (base, extra) = (count / rows, count % rows);
        let mut workers = workers.into_iter();
        let rows = (0..rows)
            .map(|row| {
                let size = base + usize::from(row < extra);
                even(workers.by_ref().take(size).collect(), true)
            })
            .collect();
        Node::Split {
            id: "grid".into(),
            vertical: true,
            ratio: grid_main_ratio(count),
            children: Box::new([main, even(rows, false)]),
        }
    }
    /// How many rows a stack of rows holds; anything else is one row.
    pub fn rows(&self) -> usize {
        match self {
            Node::Split {
                vertical: false,
                children,
                ..
            } => children[0].rows() + children[1].rows(),
            _ => 1,
        }
    }
    /// Only the main pane left: the workspace has no splits.
    pub fn is_single(&self) -> bool {
        matches!(self, Node::Leaf { .. })
    }
}

/// automaticChatRatio: the main pane narrows as workers arrive.
fn grid_main_ratio(workers: usize) -> f32 {
    match workers {
        ..=1 => 0.5,
        ..=3 => 0.4,
        4 => 0.38,
        ..=6 => 0.32,
        ..=8 => 0.28,
        _ => 0.24,
    }
}

/// equalSplit: halves that keep every node the same size. A split is named
/// for the nodes it holds, so a rebuilt grid keeps its dividers' ids.
fn even(mut nodes: Vec<Node>, vertical: bool) -> Node {
    if nodes.len() == 1 {
        return nodes.remove(0);
    }
    let first = nodes.len() / 2;
    let id = format!(
        "grid-{}-{}-{}",
        if vertical { "row" } else { "rows" },
        nodes[0].id(),
        nodes[nodes.len() - 1].id()
    );
    let ratio = first as f32 / nodes.len() as f32;
    let second = nodes.split_off(first);
    Node::Split {
        id,
        vertical,
        ratio,
        children: Box::new([even(nodes, vertical), even(second, vertical)]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_moved_pane_splits_under_a_fresh_id() {
        let mut tree = Node::main();
        assert!(tree.split(MAIN, Zone::Right, "a".into(), chat("a")));
        assert!(tree.split("a", Zone::Below, "b".into(), chat("b")));
        // Move a beside main: its old split stays as main's parent.
        assert!(tree.close("a"));
        assert!(tree.split(MAIN, Zone::Left, "a".into(), chat("a")));
        let mut ids = vec![];
        tree.ids(&mut ids);
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(ids.len(), unique.len(), "{ids:?}");
        assert!(ids.contains(&"split-a-2".to_owned()), "{ids:?}");
    }
    fn worker(n: usize) -> Node {
        Node::Leaf {
            id: format!("w{n}"),
            content: Leaf::Worker {
                agent: format!("agent {n}"),
            },
        }
    }
    /// Each row's worker ids, top to bottom.
    fn rows(node: &Node) -> Vec<Vec<String>> {
        match node {
            Node::Split {
                vertical: false,
                children,
                ..
            } => {
                let mut all = rows(&children[0]);
                all.extend(rows(&children[1]));
                all
            }
            row => vec![row.leaves().iter().map(|(id, _)| id.to_string()).collect()],
        }
    }
    fn grid(count: usize) -> (f32, Vec<Vec<String>>) {
        let Node::Split {
            id,
            vertical: true,
            ratio,
            children,
        } = Node::worker_grid(Node::main(), (1..=count).map(worker).collect(), 4)
        else {
            panic!("a grid beside main")
        };
        assert_eq!((id.as_str(), children[0].id()), ("grid", MAIN));
        (ratio, rows(&children[1]))
    }
    #[test]
    fn workers_fill_even_rows_beside_a_narrowing_main_pane() {
        let (ratio, shape) = grid(1);
        assert_eq!((ratio, shape), (0.5, vec![vec!["w1".to_string()]]));
        let (ratio, shape) = grid(4);
        assert_eq!(ratio, 0.38);
        assert_eq!(shape.iter().map(Vec::len).collect::<Vec<_>>(), [2, 2]);
        let (ratio, shape) = grid(7);
        assert_eq!(ratio, 0.28);
        assert_eq!(shape.iter().map(Vec::len).collect::<Vec<_>>(), [3, 2, 2]);
        let (ratio, shape) = grid(10);
        assert_eq!(ratio, 0.24);
        assert_eq!(shape.iter().map(Vec::len).collect::<Vec<_>>(), [4, 3, 3]);
        assert_eq!(shape[0], ["w1", "w2", "w3", "w4"]);
        assert_eq!(shape[2], ["w8", "w9", "w10"]);
        let Node::Split { children, .. } =
            Node::worker_grid(Node::main(), (1..=10).map(worker).collect(), 4)
        else {
            panic!("a grid beside main")
        };
        assert_eq!(children[1].rows(), 3);
        assert!(Node::worker_grid(Node::main(), vec![], 4).is_single());
        // A narrow pane keeps two columns and adds rows instead.
        let Node::Split { children, .. } =
            Node::worker_grid(Node::main(), (1..=10).map(worker).collect(), 2)
        else {
            panic!("a grid beside main")
        };
        let narrow = rows(&children[1]);
        assert_eq!(
            narrow.iter().map(Vec::len).collect::<Vec<_>>(),
            [2, 2, 2, 2, 2]
        );
    }
    #[test]
    fn a_rebuilt_grid_keeps_its_divider_ids_and_closing_reflows() {
        let ten = Node::worker_grid(Node::main(), (1..=10).map(worker).collect(), 4);
        let mut again = vec![];
        Node::worker_grid(Node::main(), (1..=10).map(worker).collect(), 4).ids(&mut again);
        let mut first = vec![];
        ten.ids(&mut first);
        assert_eq!(first, again);
        let mut unique = first.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            first.len(),
            "every pane and divider has its own id"
        );
        let mut closed = ten;
        assert!(closed.close("w5"));
        assert_eq!(closed.leaves().len(), 10, "main and nine workers");
        assert!(!closed.close(MAIN));
    }
    fn chat(id: &str) -> Leaf {
        Leaf::Chat {
            session: id.into(),
        }
    }
    fn ids(node: &Node) -> Vec<String> {
        node.leaves().into_iter().map(|(id, _)| id.to_owned()).collect()
    }
    #[test]
    fn zones_follow_workspace_tab_drop_zone() {
        assert_eq!(Zone::at(0.1, 0.5), Zone::Left);
        assert_eq!(Zone::at(0.9, 0.5), Zone::Right);
        assert_eq!(Zone::at(0.5, 0.1), Zone::Above);
        assert_eq!(Zone::at(0.5, 0.95), Zone::Below);
        assert_eq!(Zone::at(0.5, 0.5), Zone::Center);
        assert_eq!(Zone::at(0.3, 0.5), Zone::Center);
    }
    #[test]
    fn panes_split_without_limit_close_and_resize() {
        let mut root = Node::main();
        assert!(root.split(MAIN, Zone::Right, "a".into(), chat("1")));
        assert!(root.split("a", Zone::Below, "b".into(), Leaf::Terminal { session: None }));
        assert!(root.split(MAIN, Zone::Left, "c".into(), chat("2")));
        assert!(root.split("b", Zone::Center, "d".into(), chat("3")));
        assert_eq!(ids(&root), ["c", "main", "a", "b", "d"]);
        assert!(!root.split("missing", Zone::Left, "e".into(), chat("4")));
        let Node::Split { id, vertical, .. } = &root else { panic!() };
        assert!(*vertical);
        let top = id.clone();
        assert!(root.resize(&top, 0.99));
        let Node::Split { ratio, .. } = &root else { panic!() };
        assert_eq!(*ratio, 0.85);
        assert!(!root.close(MAIN));
        assert!(root.close("b"));
        assert!(root.close("c"));
        assert!(root.close("a"));
        assert!(root.close("d"));
        assert!(root.is_single());
        let saved = serde_json::to_string(&root).unwrap();
        assert_eq!(serde_json::from_str::<Node>(&saved).unwrap(), root);
    }
}
