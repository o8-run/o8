//! Read-only approval evidence, using the classic panel's active-project read.
use super::*;
use gpui::KeyDownEvent;

pub(super) const LANE: usize = 5;
const RISKS: [&str; 4] = ["All risks", "High", "Medium", "Low"];
const RANGES: [&str; 5] = [
    "All time", "Last hour", "Last 24 hours", "Last 7 days", "Last 30 days",
];

#[derive(Clone, Debug)]
pub(super) struct Row {
    pub approval_id: String,
    pub title: String,
    pub session: String,
    pub risk: String,
    pub timestamp: f64,
    pub event: Value,
}
fn flatten(approvals: &[Value]) -> Vec<Row> {
    let mut rows = Vec::new();
    for approval in approvals {
        for event in approval["audit"].as_array().into_iter().flatten() {
            rows.push(Row {
                approval_id: text(approval, "id"),
                title: text(approval, "title"),
                session: text(approval, "sessionKey"),
                risk: text(approval, "risk"),
                timestamp: event["timestamp"]
                    .as_f64()
                    .or(approval["updatedAt"].as_f64())
                    .unwrap_or(0.),
                event: event.clone(),
            });
        }
    }
    // Stable sorting preserves approval/event order for equal timestamps.
    rows.sort_by(|a, b| b.timestamp.total_cmp(&a.timestamp));
    rows
}
pub(super) struct Audit {
    pub rows: Vec<Row>,
    pub session: Option<String>,
    pub risk: usize,
    pub range: usize,
    pub loading: bool,
    pub loaded: bool,
    pub error: Option<String>,
    pub last_refresh: Instant,
    pub menu: Option<usize>,
    pub cursor: usize,
    pub focus: Vec<FocusHandle>,
    pub scroll: gpui::ScrollHandle,
    pub menu_scroll: gpui::ScrollHandle,
}
impl Audit {
    pub fn new(cx: &mut Context<Inbox>) -> Self {
        Self {
            rows: vec![],
            session: None,
            risk: 0,
            range: 0,
            loading: false,
            loaded: false,
            error: None,
            last_refresh: Instant::now(),
            menu: None,
            cursor: 0,
            focus: (0..6).map(|_| cx.focus_handle()).collect(),
            scroll: gpui::ScrollHandle::new(),
            menu_scroll: gpui::ScrollHandle::new(),
        }
    }
    fn begin(&mut self) -> bool {
        if self.loading {
            return false;
        }
        self.loading = true;
        self.last_refresh = Instant::now();
        true
    }
    fn accept(&mut self, result: Result<ApprovalsResponse, String>) {
        self.loading = false;
        match result {
            Ok(response) => {
                self.rows = flatten(&response.approvals);
                self.loaded = true;
                self.error = None;
            }
            Err(error) => {
                self.error = Some(
                    error
                        .find("HTTP ")
                        .map(|index| error[index..].to_owned())
                        .unwrap_or(error),
                );
            }
        }
    }
    fn sessions(&self) -> Vec<String> {
        let mut sessions = self
            .rows
            .iter()
            .map(|r| r.session.clone())
            .collect::<Vec<_>>();
        sessions.sort();
        sessions.dedup();
        sessions
    }
    pub fn options(&self, filter: usize) -> Vec<String> {
        match filter {
            0 => std::iter::once("All sessions".into())
                .chain(self.sessions())
                .collect(),
            1 => RISKS.iter().map(|s| (*s).into()).collect(),
            _ => RANGES.iter().map(|s| (*s).into()).collect(),
        }
    }
    fn choose(&mut self, filter: usize, index: usize) {
        match filter {
            0 => {
                self.session = index
                    .checked_sub(1)
                    .and_then(|i| self.sessions().get(i).cloned())
            }
            1 => self.risk = index.min(RISKS.len() - 1),
            _ => self.range = index.min(RANGES.len() - 1),
        }
        self.menu = None;
        self.scroll.scroll_to_item(0);
    }
    fn has_filters(&self) -> bool {
        self.session.is_some() || self.risk != 0 || self.range != 0
    }
    fn focusable_controls(&self) -> Vec<usize> {
        let mut controls = vec![0, 1, 2];
        if self.has_filters() { controls.push(3); }
        if !self.loading {
            controls.push(4);
            if self.error.is_some() { controls.push(5); }
        }
        controls
    }
    fn clear(&mut self) {
        self.session = None;
        self.risk = 0;
        self.range = 0;
        self.menu = None;
        self.scroll.scroll_to_item(0);
    }
    pub fn visible(&self, now: f64) -> Vec<Row> {
        let hours = [0., 1., 24., 168., 720.][self.range];
        self.rows
            .iter()
            .filter(|row| {
                self.session.as_ref().is_none_or(|s| s == &row.session)
                    && (self.risk == 0 || row.risk == RISKS[self.risk].to_lowercase())
                    && (hours == 0. || row.timestamp >= now - hours * 3_600_000.)
            })
            .cloned()
            .collect()
    }
}
pub(super) fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
impl Inbox {
    pub(super) fn view_loading(&self) -> bool {
        if self.lane == LANE {
            self.audit.loading
        } else {
            self.loading
        }
    }
    pub(super) fn load_audit(&mut self, cx: &mut Context<Self>) {
        if !self.audit.begin() {
            return;
        }
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<ApprovalsResponse>("/api/panel/approvals", &[("status", "all")])
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.audit.accept(result);
                if this.lane == LANE {
                    this.selected = this.selected.min(
                        this.audit.visible(now()).len().saturating_sub(1)
                    );
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn audit_control(&mut self, control: usize, cx: &mut Context<Self>) {
        match control {
            0..=2 => {
                self.audit.menu = if self.audit.menu == Some(control) {
                    None
                } else {
                    Some(control)
                };
                self.audit.cursor = 0;
                self.audit.menu_scroll.scroll_to_item(0);
            }
            3 => {
                self.audit.clear();
                self.selected = 0;
            }
            _ => self.load_audit(cx),
        }
        cx.notify();
    }
    pub(super) fn audit_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.lane != LANE {
            return false;
        }
        let key = event.keystroke.key.as_str();
        if let Some(filter) = self.audit.menu {
            let count = self.audit.options(filter).len() + 1;
            match key {
                "escape" => self.audit.menu = None,
                "up" => self.audit.cursor = (self.audit.cursor.min(count - 1) + count - 1) % count,
                "down" => self.audit.cursor = (self.audit.cursor + 1) % count,
                "enter" | "space" => {
                    if self.audit.cursor >= count - 1 {
                        self.audit.menu = None;
                    } else {
                        self.audit.choose(filter, self.audit.cursor);
                        self.selected = 0;
                    }
                }
                "tab" => {
                    self.audit.menu = None;
                }
                _ => {
                    cx.stop_propagation();
                    return true;
                }
            }
            self.audit.menu_scroll.scroll_to_item(self.audit.cursor);
            if key != "tab" {
                cx.stop_propagation();
                cx.notify();
                return true;
            }
        }
        match key {
            "tab" => {
                let controls = self.audit.focusable_controls();
                let count = controls.len();
                let current = controls.iter()
                    .position(|i| self.audit.focus[*i].is_focused(window));
                let next = if event.keystroke.modifiers.shift {
                    current
                        .map(|i| (i + count - 1) % count)
                        .unwrap_or(count - 1)
                } else {
                    current.map(|i| (i + 1) % count).unwrap_or(0)
                };
                self.audit.focus[controls[next]].focus(window);
            }
            "up" | "down" => {
                self.selected = if key == "up" {
                    self.selected.saturating_sub(1)
                } else {
                    (self.selected + 1).min(self.audit.visible(now()).len().saturating_sub(1))
                };
                self.audit.scroll.scroll_to_item(self.selected);
            }
            "enter" | "space" => {
                if let Some(i) = self.audit.focusable_controls().into_iter()
                    .find(|i| self.audit.focus[*i].is_focused(window)) {
                    self.audit_control(i, cx);
                }
            }
            "escape" => self.audit.menu = None,
            _ => return false,
        }
        cx.stop_propagation();
        cx.notify();
        true
    }
}

#[cfg(test)]
#[path = "approval_audit_tests.rs"]
mod tests;
#[path = "approval_audit_view.rs"]
mod view;
