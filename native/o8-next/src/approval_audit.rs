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
    pub shown: usize,
    pub total: usize,
    pub fetch_limit: usize,
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
            shown: 50,
            total: 0,
            fetch_limit: 50,
            session: None,
            risk: 0,
            range: 0,
            loading: false,
            loaded: false,
            error: None,
            last_refresh: Instant::now(),
            menu: None,
            cursor: 0,
            focus: (0..7).map(|_| cx.focus_handle()).collect(),
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
                self.total = response.total.unwrap_or(self.rows.len()).max(self.rows.len());
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
        self.shown = 50;
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
    fn more(&self) -> bool {
        self.visible(now()).len() > self.shown || self.rows.len() < self.total
    }
    fn focusable_controls(&self) -> Vec<usize> {
        let mut controls = vec![0, 1, 2];
        if self.has_filters() { controls.push(3); }
        if !self.loading {
            controls.push(4);
            if self.more() { controls.push(6); }
            if self.error.is_some() { controls.push(5); }
        }
        controls
    }
    fn clear(&mut self) {
        self.shown = 50;
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
#[path = "approval_audit_controls.rs"]
mod controls;

#[cfg(test)]
#[path = "approval_audit_tests.rs"]
mod tests;
#[path = "approval_audit_view.rs"]
mod view;
