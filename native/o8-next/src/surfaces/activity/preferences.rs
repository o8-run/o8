//! View-only state in the surface's existing WorkspaceState slot.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Slice {
    /// Absent until the operator changes Activity's view, so other
    /// workspaces keep their saved JSON shape.
    #[serde(skip_serializing_if = "Saved::is_empty")]
    pub activity_preferences: Saved,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Saved {
    pub scope: Option<String>,
    pub views: BTreeMap<String, ViewState>,
    pub proposals_open: Option<bool>,
    pub seen: Vec<String>,
}
impl Saved {
    fn is_empty(&self) -> bool {
        self.scope.is_none()
            && self.views.is_empty()
            && self.proposals_open.is_none()
            && self.seen.is_empty()
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ViewState {
    pub filter: String,
    pub expanded: Option<String>,
    pub scroll: f32,
}
impl ActivityPane {
    pub(crate) fn hydrate(&mut self, saved: Saved, open: bool, seen: Vec<String>) {
        self.saved = saved;
        self.saved.proposals_open = Some(open);
        self.saved.seen = seen.clone();
        self.proposals.open = open;
        self.proposals.snapshot = seen.iter().cloned().collect();
        self.proposals.seen = seen;
        if let Some(scope) = self
            .saved
            .scope
            .clone()
            .filter(|p| p == "*" || !p.is_empty())
        {
            self.scope = scope;
        }
        self.restore_view();
    }
    pub(super) fn remember_view(&mut self, cx: &mut Context<Self>) {
        self.saved.scope = Some(self.scope.clone());
        self.saved.views.insert(
            self.scope.clone(),
            ViewState {
                filter: self.filter.into(),
                expanded: self.expanded.clone(),
                scroll: f32::from(self.scroll.offset().y),
            },
        );
        cx.emit(ActivityEvent::Preferences(self.saved.clone()));
    }
    pub(super) fn restore_view(&mut self) {
        let state = self
            .saved
            .views
            .get(&self.scope)
            .cloned()
            .unwrap_or_default();
        self.filter = match state.filter.as_str() {
            "commit" => "commit",
            "pr" => "pr",
            "issue" => "issue",
            "ci" => "ci",
            "packet" => "packet",
            _ => "all",
        };
        self.expanded = state.expanded;
        self.restore_y = Some(if state.scroll.is_finite() {
            state.scroll.clamp(-10_000_000., 0.)
        } else {
            0.
        });
    }
    pub(super) fn restore_scroll(&mut self) {
        if self.loading || self.decisions.loading || self.proposals.loading {
            return;
        }
        if let Some(y) = self.restore_y.take() {
            self.scroll
                .set_offset(gpui::point(gpui::px(0.), gpui::px(y)));
        }
    }
    pub(super) fn mark_proposals_seen(&mut self, cx: &mut Context<Self>) {
        if !self.proposals.open {
            return;
        }
        let mut changed = false;
        for p in self.proposals.rows() {
            if let Some(id) = p["id"].as_str() {
                if !self.proposals.seen.iter().any(|s| s == id) {
                    self.proposals.seen.push(id.into());
                    changed = true;
                }
            }
        }
        if self.proposals.seen.len() > 200 {
            self.proposals.seen.drain(..self.proposals.seen.len() - 200);
        }
        if changed {
            self.saved.seen = self.proposals.seen.clone();
            cx.emit(ActivityEvent::Preferences(self.saved.clone()));
        }
    }
}
