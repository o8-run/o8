//! Conversation helpers stay with their visible parent, ahead of section folding.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, MouseButton, div, px};

const INDENT: f32 = 12.;
const DOWN: &str = "M6 9l6 6 6-6";
const RIGHT: &str = "M9 6l6 6-6 6";

impl ThreadList {
    /// Work only with this page's rows. Missing parents leave ordinary rows;
    /// pinned children keep their shelf position. Search and scope stay flat.
    pub(super) fn nest_rows(&self, rows: Vec<Row>, sessions: &[Session]) -> Vec<Row> {
        if !self.query.trim().is_empty() || !self.scope_keys().is_empty() {
            return rows;
        }
        let visible: HashSet<_> = rows.iter().filter_map(|r| r.id.as_deref()).collect();
        let mut parents: HashMap<String, String> = sessions
            .iter()
            .filter(|s| visible.contains(s.id.as_str()) && s.pinned_at.is_none())
            .filter_map(|s| {
                let parent = crate::lineage::parent(s)?;
                let parent = s.machine.as_deref().map_or_else(
                    || parent.to_owned(),
                    |machine| crate::shell::session::machine_thread_id(machine, parent),
                );
                (parent != s.id && visible.contains(parent.as_str()))
                    .then(|| (s.id.clone(), parent))
            })
            .collect();
        // Malformed cycles must never hide the whole family or loop on paint.
        let cyclic: Vec<_> = parents
            .keys()
            .filter(|id| {
                let mut seen = HashSet::new();
                let mut at = id.as_str();
                while let Some(parent) = parents.get(at) {
                    if !seen.insert(at) {
                        return true;
                    }
                    at = parent;
                }
                false
            })
            .cloned()
            .collect();
        for id in cyclic {
            parents.remove(&id);
        }
        if parents.is_empty() {
            return rows;
        }
        let (mut children, mut roots) = (HashMap::new(), Vec::new());
        for row in rows {
            if let Some(id) = row.id.as_ref().filter(|id| parents.contains_key(*id)) {
                children.insert(id.clone(), row);
            } else {
                roots.push(row);
            }
        }
        let mut families: HashMap<String, Vec<Row>> = HashMap::new();
        let mut active = HashSet::new();
        // The same timestamp ordering as top-level rows, including millisecond ties.
        for session in recents::visible(sessions, "", &HashSet::new()) {
            if let Some(row) = children.remove(&session.id) {
                let parent = parents[&session.id].clone();
                if row.running || inbox::needs_input(session) {
                    active.insert(parent.clone());
                }
                families.entry(parent).or_default().push(row);
            }
        }
        let mut pending: Vec<_> = roots.drain(..).rev().map(|r| (r, 0)).collect();
        let mut nested = Vec::new();
        while let Some((mut row, depth)) = pending.pop() {
            row.depth = depth;
            if let Some(id) = &row.id
                && let Some(children) = families.remove(id)
            {
                row.child_count = children.len();
                row.children_open = self
                    .child_disclosures
                    .get(id)
                    .copied()
                    .unwrap_or(self.detailed && active.contains(id));
                if row.children_open {
                    pending.extend(children.into_iter().rev().map(|r| (r, depth + 1)));
                }
            }
            nested.push(row);
        }
        // Relocating the last child out of a date group leaves no empty heading.
        let mut rows = Vec::with_capacity(nested.len());
        let mut nested = nested.into_iter().peekable();
        while let Some(row) = nested.next() {
            let empty = (row.kind == "folder"
                || row.kind == "section" && !matches!(row.title.as_str(), "Recents" | "Archived"))
                && nested
                    .peek()
                    .is_none_or(|next| matches!(next.kind.as_str(), "section" | "folder"));
            if !empty {
                rows.push(row);
            }
        }
        rows
    }

    pub(super) fn child_inset(row: &Row) -> f32 {
        6. + INDENT * row.depth as f32
    }

    fn set_children_open(&mut self, id: String, open: bool, cx: &mut Context<Self>) {
        if !open
            && let Some(at) = self.rows.iter().position(|r| r.id.as_ref() == Some(&id))
            && self.rows[at + 1..]
                .iter()
                .take_while(|r| r.depth > self.rows[at].depth)
                .any(|r| r.id == self.choice)
        {
            self.choice = Some(id.clone());
            self.follow_selection = false;
        }
        self.child_disclosures.insert(id, open);
        self.rebuild();
        cx.notify();
    }

    pub(super) fn children_key(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let Some(row) = self
            .rows
            .iter()
            .find(|r| r.id == self.choice && r.child_count > 0)
        else {
            return false;
        };
        let Some(open) = (match key {
            "right" => Some(true),
            "left" => Some(false),
            _ => None,
        }) else {
            return false;
        };
        self.set_children_open(row.id.clone().unwrap(), open, cx);
        true
    }

    pub(super) fn children_disclosure(
        &self,
        row: &Row,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let id = row.id.clone().filter(|_| row.child_count > 0)?;
        let selector = format!("thread-children-{id}");
        let count_selector = format!("thread-children-count-{id}:{}", row.child_count);
        let open = row.children_open;
        Some(
            div()
                .id(gpui::ElementId::Name(selector.clone().into()))
                .debug_selector(move || selector.clone())
                .h(px(26.))
                .min_w(px(26.))
                .px(px(4.))
                .ml(px(4.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .gap(px(3.))
                .rounded(px(7.))
                .cursor_pointer()
                .hover(|s| s.bg(theme().hover))
                .tooltip(move |_, cx| {
                    cx.new(|_| {
                        crate::icon::Tip(
                            if open {
                                "Collapse helpers"
                            } else {
                                "Expand helpers"
                            }
                            .into(),
                        )
                    })
                    .into()
                })
                .child(crate::icon::stroke(
                    if open { DOWN } else { RIGHT },
                    theme().text_faint,
                    11.,
                    1.8,
                ))
                .child(
                    div()
                        .debug_selector(move || count_selector.clone())
                        .text_size(px(9.5))
                        .font_weight(gpui::FontWeight(260.))
                        .text_color(theme().text_faint)
                        .child(row.child_count.to_string()),
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.focus.focus(window);
                    this.set_children_open(id.clone(), !open, cx);
                }))
                .into_any_element(),
        )
    }
}
