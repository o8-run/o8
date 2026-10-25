#[path = "actions.rs"]
mod actions;
use super::{model::Task, *};
use crate::theme::current as theme;
use crate::{
    composer::{Composer, Submit},
    diff_ui::DiffSurface,
};
use gpui::{FontWeight, SharedString};
use serde_json::Value;

pub struct Card {
    pub task: Task,
    pub compact: bool,
    pub revision: u64,
    pub selected: bool,
    pub expanded: bool,
    client: Client,
    pub focus: FocusHandle,
    pub(super) activity: Vec<Value>,
    loading: bool,
    loaded: bool,
    error: String,
    pub(super) composer: Entity<Composer>,
    pub(super) pending: Option<Value>,
    draft_slot: super::drafts::Slot,
    busy: bool,
    notice: String,
    diff: Option<Entity<DiffSurface>>,
    _subscriptions: Vec<gpui::Subscription>,
    action_focus: [FocusHandle; 4],
}
impl Card {
    pub fn new(
        client: Client,
        task: Task,
        compact: bool,
        draft_slot: super::drafts::Slot,
        cx: &mut Context<Self>,
    ) -> Self {
        let (draft, notice) = match draft_slot.load() {
            Ok(draft) => (draft, String::new()),
            Err(error) => (super::drafts::Draft::default(), error),
        };
        let composer = cx.new(|cx| {
            let mut editor = Composer::new(cx);
            editor.set_text(&draft.text, cx);
            editor.focus = editor.focus.tab_index(2).tab_stop(true);
            editor
        });
        let submit = cx.subscribe(&composer, |this, _, _: &Submit, cx| this.send(cx));
        let observe = cx.observe(&composer, |this, _, cx| {
            if let Err(error) = this
                .draft_slot
                .save(this.composer.read(cx).text.clone(), this.pending.clone())
            {
                this.notice = error;
            }
            cx.notify();
        });
        Self {
            composer,
            pending: draft.pending,
            draft_slot,
            busy: false,
            notice,
            diff: None,
            _subscriptions: vec![submit, observe],
            action_focus: std::array::from_fn(|_| cx.focus_handle()),
            task,
            compact,
            revision: 0,
            selected: false,
            expanded: false,
            client,
            focus: cx.focus_handle(),
            activity: vec![],
            loading: false,
            loaded: false,
            error: String::new(),
        }
    }
    pub fn update(&mut self, task: Task, cx: &mut Context<Self>) {
        if self.task != task {
            self.task = task;
            self.revision += 1;
            cx.notify();
        }
        if self.expanded {
            self.load_activity(cx);
        }
    }
    pub fn focus_actions(&self, window: &mut Window) {
        self.action_focus[0].focus(window);
    }
    pub fn toggle_activity(&mut self, cx: &mut Context<Self>) {
        self.expanded = !self.expanded;
        if self.expanded && (!self.loaded || !self.error.is_empty()) {
            self.load_activity(cx);
        }
        cx.notify();
    }
    fn load_activity(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.task.lane_id().is_empty() {
            return;
        }
        self.loading = true;
        let client = self.client.clone();
        let lane = self.task.lane_id();
        let task = cx.background_executor().spawn(async move {
            let id: String = url::form_urlencoded::byte_serialize(lane.as_bytes()).collect();
            let value: Value = client.get(&format!("/api/lanes/{id}"), &[("events", "500")])?;
            value["events"]
                .as_array()
                .cloned()
                .ok_or_else(|| "Activity is unavailable".to_owned())
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(events) => {
                        let changed =
                            this.activity != events || !this.loaded || !this.error.is_empty();
                        this.loaded = true;
                        this.activity = events;
                        this.error.clear();
                        if changed {
                            cx.notify();
                        }
                    }
                    Err(error) => {
                        this.error = error;
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }
    fn status_line(&self) -> String {
        let reason = self.task.text("blockedReason");
        if !reason.is_empty() {
            return reason;
        }
        match self.task.filter {
            0 => "The worker is working on this task.",
            1 => "The work is ready for review.",
            _ => "The worker needs a decision.",
        }
        .into()
    }
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "tab"
            && !event.keystroke.modifiers.control
            && !event.keystroke.modifiers.platform
        {
            let mut handles = Vec::new();
            if !self.busy {
                handles.push(self.action_focus[0].clone());
                if !self.task.lane_id().is_empty() {
                    handles.push(self.action_focus[1].clone());
                }
            }
            handles.push(self.composer.read(cx).focus.clone());
            if !self.busy
                && (self.pending.is_some() || !self.composer.read(cx).text.trim().is_empty())
            {
                handles.push(self.action_focus[2].clone());
            }
            if self.diff.is_some() {
                handles.push(self.action_focus[3].clone());
            }
            let current = handles.iter().position(|handle| handle.is_focused(window));
            let next = if event.keystroke.modifiers.shift {
                current
                    .map(|i| (i + handles.len() - 1) % handles.len())
                    .unwrap_or(handles.len() - 1)
            } else {
                current.map(|i| (i + 1) % handles.len()).unwrap_or(0)
            };
            handles[next].focus(window);
            cx.stop_propagation();
            return;
        }
        if self.focus.is_focused(window)
            && ["enter", "space"].contains(&event.keystroke.key.as_str())
        {
            self.toggle_activity(cx);
            cx.stop_propagation();
        }
    }
}
impl Render for Card {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let id = format!("worker-card-{}", self.task.id);
        let status_id = format!("worker-status-{}", self.task.id);
        let activity_id = format!("worker-activity-{}", self.task.id);
        let tone = match self.task.filter {
            0 => theme().accent,
            1 => theme().warning,
            _ => theme().danger,
        };
        let header = div()
            .w_full()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(9.5))
                    .font_weight(FontWeight(260.))
                    .text_color(theme().text_faint)
                    .child(
                        div()
                            .px(px(6.))
                            .py(px(3.))
                            .rounded(px(7.))
                            .bg(theme().hover)
                            .child(self.task.repo()),
                    )
                    .child(self.task.text("referenceLabel")),
            )
            .child(
                div()
                    .id(SharedString::from(status_id.clone()))
                    .debug_selector(move || status_id.clone())
                    .px(px(7.))
                    .py(px(3.))
                    .rounded(px(7.))
                    .bg(theme().hover)
                    .text_size(px(11.))
                    .text_color(tone)
                    .child(self.task.status()),
            );
        let disclosure = div()
            .id(SharedString::from(activity_id.clone()))
            .debug_selector(move || activity_id.clone())
            .flex()
            .items_center()
            .gap(px(6.))
            .min_h(px(26.))
            .text_size(px(12.))
            .text_color(theme().text_secondary)
            .cursor_pointer()
            .child(if self.expanded { "⌄" } else { "›" })
            .child("Activity")
            .on_click(cx.listener(|this, _, window, cx| {
                this.focus.focus(window);
                this.toggle_activity(cx);
                cx.stop_propagation();
            }));
        let mut activity = div().flex().flex_col().gap(px(8.));
        if self.expanded {
            if self.loading && !self.loaded {
                activity = activity.child(
                    div()
                        .text_color(theme().text_faint)
                        .child("Reading activity…"),
                );
            }
            if !self.error.is_empty() {
                activity =
                    activity.child(div().text_color(theme().danger).child(self.error.clone()));
            }
            let messages: Vec<_> = self
                .activity
                .iter()
                .filter_map(|event| {
                    ["message", "summary", "note"]
                        .iter()
                        .find_map(|key| event["payload"][key].as_str())
                        .filter(|s| !s.trim().is_empty())
                })
                .collect();
            for (index, message) in messages.iter().enumerate() {
                let number = format!("{:02}", index + 1);
                let step_id = format!("worker-step-{}-{number}", self.task.id);
                activity = activity.child(
                    div()
                        .debug_selector(move || step_id.clone())
                        .flex()
                        .gap(px(12.))
                        .text_size(px(12.))
                        .child(
                            div()
                                .w(px(20.))
                                .flex_shrink_0()
                                .font_weight(FontWeight(260.))
                                .text_color(theme().text_faint)
                                .child(number),
                        )
                        .child(div().flex_1().min_w_0().child((*message).to_owned())),
                );
            }
        }
        let card = div()
            .id(SharedString::from(id.clone()))
            .debug_selector(move || id.clone())
            .w_full()
            .px(px(16.))
            .py(px(if self.compact { 10. } else { 16. }))
            .border_1()
            .border_color(if self.selected {
                theme().accent
            } else {
                theme().border
            })
            .rounded(px(14.))
            .bg(theme().surface)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(FontWeight::LIGHT)
            .text_size(px(12.))
            .flex()
            .flex_col()
            .gap(px(if self.compact { 6. } else { 12. }))
            .child(header)
            .child(div().text_size(px(13.5)).child(self.task.text("title")))
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .text_color(theme().text_secondary)
                    .child(div().w(px(14.)).flex_shrink_0().text_color(tone).child("◉"))
                    .child(div().flex_1().min_w_0().child(self.status_line())),
            )
            .child(disclosure)
            .when(self.expanded, |v| v.child(activity));
        div()
            .track_focus(&self.focus)
            .tab_stop(false)
            .on_key_down(cx.listener(Self::key_down))
            .w_full()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(card)
            .child(self.actions_view(cx))
    }
}
