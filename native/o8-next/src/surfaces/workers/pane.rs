use super::{
    card::Card,
    model::{self, FILTERS},
    *,
};
use crate::theme::current as theme;
use gpui::{ScrollHandle, SharedString};
use serde_json::Value;
use std::time::Instant;

pub struct Workers {
    client: Client,
    workspace: String,
    pub cards: HashMap<String, Entity<Card>>,
    order: Vec<String>,
    pub filter: usize,
    pub compact: bool,
    pub selected: Option<String>,
    pub scroll: [ScrollHandle; 3],
    pub focus: FocusHandle,
    pub loading: bool,
    polling: bool,
    since: u64,
    last_scan: Instant,
    pub notice: String,
}
impl Workers {
    pub fn new(client: Client, workspace: String, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            client,
            workspace,
            cards: HashMap::new(),
            order: vec![],
            filter: 0,
            compact: false,
            selected: None,
            scroll: std::array::from_fn(|_| ScrollHandle::new()),
            focus: cx.focus_handle(),
            loading: false,
            polling: false,
            since: 0,
            last_scan: Instant::now(),
            notice: String::new(),
        };
        this.load(cx);
        this
    }
    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        if let Some(previous) = self.selected.as_ref().and_then(|id| self.cards.get(id)) {
            previous.update(cx, |card, cx| {
                card.selected = false;
                cx.notify();
            });
        }
        if let Some(card) = self.cards.get(&id) {
            card.update(cx, |card, cx| {
                card.selected = true;
                cx.notify();
            });
        }
        self.selected = Some(id);
    }
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) {
            return;
        }
        match event.keystroke.key.as_str() {
            "left" => {
                self.filter = (self.filter + 2) % 3;
                cx.notify();
            }
            "right" => {
                self.filter = (self.filter + 1) % 3;
                cx.notify();
            }
            "up" | "down" => {
                let ids: Vec<_> = self
                    .order
                    .iter()
                    .filter(|id| self.cards[*id].read(cx).task.filter == self.filter)
                    .cloned()
                    .collect();
                if !ids.is_empty() {
                    let position = self
                        .selected
                        .as_ref()
                        .and_then(|id| ids.iter().position(|v| v == id));
                    let next = match (position, event.keystroke.key.as_str()) {
                        (Some(i), "up") => i.saturating_sub(1),
                        (Some(i), _) => (i + 1).min(ids.len() - 1),
                        _ => 0,
                    };
                    self.select(ids[next].clone(), cx);
                    self.scroll[self.filter].scroll_to_item(next);
                }
            }
            "f5" => self.load(cx),
            _ => return,
        }
        cx.stop_propagation();
    }
    pub fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let task = cx.background_executor().spawn(async move {
            let lanes: Value = client.get("/api/lanes", &[("active", "true")])?;
            let state: Value = client.get("/api/orchestrator/state", &[])?;
            Ok::<_, String>(model::tasks(&state, &lanes, &workspace))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                this.last_scan = Instant::now();
                match result {
                    Ok(tasks) => {
                        let before: Vec<_> = this
                            .order
                            .iter()
                            .map(|id| (id.clone(), this.cards[id].read(cx).task.filter))
                            .collect();
                        let next: Vec<_> = tasks.iter().map(|t| (t.id.clone(), t.filter)).collect();
                        this.order = tasks.iter().map(|t| t.id.clone()).collect();
                        this.cards.retain(|id, _| this.order.contains(id));
                        for task in tasks {
                            if let Some(card) = this.cards.get(&task.id) {
                                card.update(cx, |card, cx| card.update(task, cx));
                            } else {
                                this.cards.insert(
                                    task.id.clone(),
                                    cx.new(|_| Card::new(task, this.compact)),
                                );
                            }
                        }
                        let clear_error = !this.notice.is_empty();
                        this.notice.clear();
                        if before != next || clear_error {
                            cx.notify();
                        }
                    }
                    Err(error) => {
                        this.notice = error;
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }
    /// The desktop's bounded lane-event long poll drives snapshot refreshes.
    /// The periodic scan also discovers packets that have not created a lane yet.
    pub fn tick(&mut self, refresh: bool, cx: &mut Context<Self>) {
        if refresh || self.last_scan.elapsed() >= Duration::from_secs(5) {
            self.load(cx);
        }
        if self.polling || self.loading {
            return;
        }
        self.polling = true;
        let client = self.client.clone();
        let since = self.since.to_string();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                "/api/orchestrator/lane-events",
                &[("since", &since), ("timeoutMs", "3000")],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.polling = false;
                match result {
                    Ok(value) => {
                        this.since = value["nextSince"].as_u64().unwrap_or(this.since);
                        if value["events"].as_array().is_some_and(|e| !e.is_empty()) {
                            this.load(cx);
                        }
                    }
                    Err(error) => {
                        if this.notice != error {
                            this.notice = error;
                            cx.notify();
                        }
                    }
                }
            });
        })
        .detach();
    }
}
impl Render for Workers {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let counts: [usize; 3] = std::array::from_fn(|f| {
            self.cards
                .values()
                .filter(|c| c.read(cx).task.filter == f)
                .count()
        });
        let mut filters = div()
            .flex()
            .gap(px(3.))
            .p(px(3.))
            .rounded(px(9.))
            .bg(theme().surface);
        for (filter, label) in FILTERS.iter().enumerate() {
            let id = format!("workers-filter-{filter}");
            filters = filters.child(
                div()
                    .id(SharedString::from(id.clone()))
                    .debug_selector(move || id.clone())
                    .px(px(9.))
                    .py(px(5.))
                    .rounded(px(7.))
                    .text_size(px(12.))
                    .bg(if self.filter == filter {
                        theme().accent
                    } else {
                        gpui::transparent_black().into()
                    })
                    .cursor_pointer()
                    .child(format!("{label} {}", counts[filter]))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.filter = filter;
                        cx.notify();
                    })),
            );
        }
        let header = div()
            .w_full()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(filters)
            .child(
                div()
                    .id("workers-compact")
                    .debug_selector(|| "workers-compact".into())
                    .px(px(9.))
                    .py(px(5.))
                    .rounded(px(7.))
                    .text_size(px(12.))
                    .bg(if self.compact {
                        theme().selection
                    } else {
                        gpui::transparent_black().into()
                    })
                    .cursor_pointer()
                    .child("Compact")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.compact = !this.compact;
                        for card in this.cards.values() {
                            card.update(cx, |card, cx| {
                                card.compact = this.compact;
                                cx.notify();
                            });
                        }
                        cx.notify();
                    })),
            );
        let mut list = div()
            .id("workers-list")
            .debug_selector(|| "workers-list".into())
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll[self.filter])
            .flex()
            .flex_col()
            .gap(px(16.))
            .py(px(16.));
        for id in &self.order {
            if self.cards[id].read(cx).task.filter != self.filter {
                continue;
            }
            let select = id.clone();
            list = list.child(
                div()
                    .id(SharedString::from(format!("worker-select-{id}")))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select(select.clone(), cx);
                    }))
                    .child(self.cards[id].clone()),
            );
        }
        div()
            .id("workers-pane")
            .debug_selector(|| "workers-pane".into())
            .size_full()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .text_color(theme().text)
            .flex()
            .justify_center()
            .px(px(24.))
            .py(px(24.))
            .child(
                div()
                    .w_full()
                    .max_w(px(800.))
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .child(header)
                    .when(!self.notice.is_empty(), |v| {
                        v.child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme().danger)
                                .child(self.notice.clone()),
                        )
                    })
                    .child(list),
            )
    }
}
