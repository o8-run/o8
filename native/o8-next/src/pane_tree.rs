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
    /// Only the main pane left: the workspace has no splits.
    pub fn is_single(&self) -> bool {
        matches!(self, Node::Leaf { .. })
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
