// A real worker beside the main chat, as classic's AgentTilePane: its live
// transcript and a steer box. Steering takes the Workers surface's own path
// and guard: a send whose delivery isn't confirmed keeps its body, so Retry
// checks the same adjustment instead of sending a second one.
use super::*;
use crate::{
    client::Client,
    composer::{Composer, Submit},
    subagents::model::{Agent, Group},
};
use gpui::{Entity, SharedString};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// How long a failed transcript read waits before the pane tries again.
const RETRY: Duration = Duration::from_secs(5);

pub(super) struct WorkerPane {
    client: Client,
    pub(super) agent: Agent,
    /// The agent left the lists; the pane keeps what it last read.
    pub(super) gone: bool,
    detail: Option<crate::pane::Pane>,
    reading: bool,
    error: Option<String>,
    /// When the last transcript read failed; it is retried after `RETRY`.
    failed_at: Option<Instant>,
    composer: Entity<Composer>,
    pending: Option<Value>,
    busy: bool,
    notice: String,
    _subscriptions: Vec<gpui::Subscription>,
}

impl WorkerPane {
    pub(super) fn new(client: Client, agent: Agent, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| {
            let mut composer = Composer::new(cx);
            composer.placeholder = format!("Steer {}", agent.title);
            composer
        });
        let submit = cx.subscribe(&composer, |this, _, _: &Submit, cx| this.send(cx));
        let observe = cx.observe(&composer, |_, _, cx| cx.notify());
        let mut this = Self {
            client,
            agent,
            gone: false,
            detail: None,
            reading: false,
            error: None,
            failed_at: None,
            composer,
            pending: None,
            busy: false,
            notice: String::new(),
            _subscriptions: vec![submit, observe],
        };
        this.read(cx);
        this
    }
    /// The agent as the lists last read it, or None once it left them.
    pub(super) fn update(&mut self, agent: Option<Agent>, cx: &mut Context<Self>) {
        let Some(agent) = agent else {
            if !self.gone {
                self.gone = true;
                cx.notify();
            }
            return;
        };
        if self.gone || self.agent != agent {
            self.gone = false;
            self.agent = agent;
            cx.notify();
        }
        self.read(cx);
        if self.detail.as_mut().is_some_and(|detail| detail.poll()) {
            self.images(cx);
            cx.notify();
        }
    }
    /// Reads the agent's transcript once it has one, then follows it live.
    fn read(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.agent.session.clone() else {
            return;
        };
        if self.reading
            || self.failed_at.is_some_and(|at| at.elapsed() < RETRY)
            || self
                .detail
                .as_ref()
                .is_some_and(|d| d.key.as_ref() == Some(&key))
        {
            return;
        }
        self.reading = true;
        let client = self.client.clone();
        let target = key.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.history(&target) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.reading = false;
                match result {
                    Ok(history) => {
                        this.error = None;
                        this.failed_at = None;
                        let mut detail = crate::pane::Pane::new(Some(key));
                        detail.install(history, this.client.clone());
                        this.detail = Some(detail);
                        this.images(cx);
                    }
                    Err(error) => {
                        this.error = Some(error);
                        this.failed_at = Some(Instant::now());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn images(&mut self, cx: &mut Context<Self>) {
        let Some(detail) = &self.detail else {
            return;
        };
        crate::ui::images::load(
            self.client.clone(),
            &detail.rows,
            &detail.list,
            &detail.images,
            cx,
            |this, cache, changed, cx| {
                if let Some(detail) = &this.detail {
                    if std::rc::Rc::ptr_eq(cache, &detail.images)
                        && crate::ui::images::invalidate(&detail.rows, &detail.list, changed)
                    {
                        cx.notify();
                    }
                }
            },
            Self::images,
        );
    }
    /// Why this worker takes no steer, if it doesn't.
    fn closed(&self) -> Option<&'static str> {
        if self.agent.native {
            Some("This agent runs inside its chat. Steer it from there.")
        } else if self.agent.shared {
            Some("A teammate's agent. Steer it from its chat.")
        } else if self.gone {
            Some("This worker is no longer listed.")
        } else if self.agent.group == Group::Done {
            Some("This worker finished.")
        } else {
            None
        }
    }
    pub(super) fn send(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.closed().is_some() || self.composer.read(cx).composing() {
            return;
        }
        let body = match self.pending.clone() {
            Some(body) => body,
            None => {
                let message = self.composer.read(cx).text.clone();
                if message.trim().is_empty() {
                    return;
                }
                static NEXT: AtomicU64 = AtomicU64::new(0);
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let id = format!("next-pane-{stamp}-{}", NEXT.fetch_add(1, Ordering::Relaxed));
                json!({ "packetId": self.agent.id, "message": message, "source": "operator", "idempotencyKey": id })
            }
        };
        self.pending = Some(body.clone());
        self.busy = true;
        self.notice.clear();
        cx.notify();
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { super::super::super::workers::steer_packet(&client, &body) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                let sent = this.pending.clone().unwrap_or_default();
                match result {
                    Ok((status, value, unknown))
                        if (200..300).contains(&status)
                            && value["ok"] == true
                            && status != 202
                            && value["result"]["inProgress"] != true
                            && !unknown =>
                    {
                        this.pending = None;
                        if this.composer.read(cx).text
                            == sent["message"].as_str().unwrap_or_default()
                        {
                            this.composer.update(cx, |composer, cx| composer.clear(cx));
                        }
                    }
                    Ok((status, value, unknown)) => {
                        // A refusal is final; anything else may have landed.
                        if !unknown && (value["ok"] == false || (400..500).contains(&status)) {
                            this.pending = None;
                        }
                        this.notice = value["error"]["message"]
                            .as_str()
                            .or(value["error"].as_str())
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                "Delivery pending. Retry to check the same adjustment.".into()
                            });
                    }
                    // The body is kept: Retry asks about this same adjustment.
                    Err(_) => {
                        this.notice =
                            "Delivery unconfirmed. Retry checks the same adjustment.".into()
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    #[cfg(test)]
    pub(super) fn steering(&self) -> (bool, Option<Value>, String) {
        (self.busy, self.pending.clone(), self.notice.clone())
    }
    #[cfg(test)]
    pub(super) fn type_steer(&mut self, text: &str, cx: &mut Context<Self>) {
        self.composer
            .update(cx, |composer, cx| composer.set_text(text, cx));
    }
}

/// The header's facts: name, model, status and its tone.
pub(super) fn facts(agent: &Agent, gone: bool) -> (String, String, String, gpui::Rgba) {
    let meta = [Some(agent.runtime.clone()), agent.model.clone()]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let tone = match agent.group {
        _ if gone => theme().text_faint,
        Group::Working => theme().success,
        Group::Attention => theme().warning,
        Group::Done => theme().text_faint,
    };
    let status = if gone {
        "Gone".into()
    } else {
        agent.status.clone()
    };
    (agent.title.clone(), meta, status, tone)
}

impl Render for WorkerPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let id = self.agent.id.clone();
        let transcript = match &self.detail {
            Some(detail) => detail.content(),
            None => div()
                .flex_1()
                .px(px(12.))
                .py(px(10.))
                .text_size(px(12.))
                .text_color(theme().text_muted)
                .child(match (&self.error, self.agent.session.is_some()) {
                    (Some(error), _) => error.clone(),
                    (None, true) => "Reading this worker…".into(),
                    (None, false) => self
                        .agent
                        .progress
                        .clone()
                        .unwrap_or_else(|| "No transcript yet.".into()),
                })
                .into_any_element(),
        };
        let footer = match self.closed() {
            Some(note) => div()
                .px(px(12.))
                .py(px(8.))
                .text_size(px(11.))
                .text_color(theme().text_faint)
                .child(note)
                .into_any_element(),
            None => {
                let can_send = !self.busy
                    && (self.pending.is_some() || !self.composer.read(cx).text.trim().is_empty());
                let send_id = format!("worker-pane-send-{id}");
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .px(px(8.))
                    .py(px(6.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .id(SharedString::from(format!("worker-pane-steer-{id}")))
                                    .debug_selector({
                                        let id = id.clone();
                                        move || format!("worker-pane-steer-{id}")
                                    })
                                    .flex_1()
                                    .min_w_0()
                                    .px(px(4.))
                                    .rounded(px(8.))
                                    .bg(theme().hover)
                                    .child(self.composer.clone()),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(send_id.clone()))
                                    .debug_selector(move || send_id.clone())
                                    .flex_shrink_0()
                                    .h(px(26.))
                                    .px(px(9.))
                                    .flex()
                                    .items_center()
                                    .rounded(px(7.))
                                    .text_size(px(12.))
                                    .bg(theme().accent)
                                    .opacity(if can_send { 1. } else { 0.4 })
                                    .when(can_send, |d| {
                                        d.cursor_pointer().hover(|d| d.opacity(0.85))
                                    })
                                    .child(if self.busy {
                                        "…"
                                    } else if self.pending.is_some() {
                                        "Retry"
                                    } else {
                                        "↑"
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.send(cx);
                                    })),
                            ),
                    )
                    .when(!self.notice.is_empty(), |d| {
                        d.child(
                            div()
                                .px(px(4.))
                                .text_size(px(11.))
                                .text_color(theme().danger)
                                .child(self.notice.clone()),
                        )
                    })
                    .into_any_element()
            }
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .child(div().flex().flex_col().flex_1().min_h_0().child(transcript))
            .child(
                div()
                    .flex_shrink_0()
                    .border_t_1()
                    .border_color(theme().border)
                    .child(footer),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::super::{State, saved};
    use super::*;
    use crate::pane_tree::{Leaf, MAIN, Node, Zone};
    use crate::shell::test_support::*;
    use gpui::Modifiers;

    fn setup(
        cx: &mut TestAppContext,
        panes: Option<Node>,
    ) -> (Fixture, Entity<Shell>, VisualTestContext) {
        let f = Fixture::start_mode(false, "--subagents");
        let state = crate::shell_state::State {
            bounds: [0., 0., 1680., 1050.],
            ..Default::default()
        };
        let (s, mut v) = open(
            f.client.clone(),
            f.root.join("worker-panes.json"),
            state,
            cx,
        );
        v.simulate_resize(size(px(1680.), px(1050.)));
        ready(&s, &mut v);
        s.update_in(&mut v, |s, w, cx| {
            if let Some(ws) = s
                .state
                .selected
                .clone()
                .and_then(|ws| s.state.workspaces.get_mut(&ws))
            {
                ws.panes = panes;
            }
            s.execute(Command::Session("thoughts-review".into()), w, cx)
        });
        ready(&s, &mut v);
        (f, s, v)
    }
    #[track_caller]
    fn until(
        s: &Entity<Shell>,
        v: &mut VisualTestContext,
        what: &str,
        done: impl Fn(&Shell, &App) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            s.update_in(v, |s, w, cx| s.tick(true, w, cx));
            v.run_until_parked();
            draw(v);
            if s.read_with(v, |s, cx| done(s, cx)) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn agents(s: &Shell) -> Vec<String> {
        saved(s)
            .leaves()
            .into_iter()
            .filter_map(|(_, leaf)| match leaf {
                Leaf::Worker { agent } => Some(agent.clone()),
                _ => None,
            })
            .collect()
    }
    fn pane(s: &Shell) -> Option<Entity<WorkerPane>> {
        s.features.read::<State>()?.workers.values().next().cloned()
    }
    /// The chat's agents are read, so any that would join has.
    fn listed(s: &Shell, cx: &App) -> bool {
        super::super::super::right_panel::subagent_list(s, cx)
            .iter()
            .any(|agent| agent.id == "subagent-calculation")
    }
    #[track_caller]
    fn click(v: &mut VisualTestContext, id: &str) {
        draw(v);
        let at = v
            .debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
            .unwrap_or_else(|| panic!("missing {id}"))
            .center();
        v.simulate_click(at, Modifiers::default());
        v.run_until_parked();
        draw(v);
    }

    #[gpui::test]
    fn a_chats_working_agent_joins_beside_it_and_stays_closed(cx: &mut TestAppContext) {
        let (_f, s, mut v) = setup(cx, None);
        until(&s, &mut v, "the worker's transcript", |s, cx| {
            pane(s).is_some_and(|pane| pane.read(cx).detail.is_some())
        });
        assert_eq!(
            s.read_with(&v, |s, _| agents(s)),
            ["subagent-calculation"],
            "only this chat's working agent joins: not its finished or review ones, nor another chat's"
        );
        draw(&mut v);
        assert!(
            v.debug_bounds("pane-main").is_some(),
            "the chat keeps its pane"
        );
        assert!(
            v.debug_bounds("worker-pane-steer-subagent-calculation")
                .is_some()
        );

        click(&mut v, "pane-close-worker-subagent-calculation");
        for _ in 0..10 {
            s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
            v.run_until_parked();
        }
        assert!(
            s.read_with(&v, |s, _| agents(s)).is_empty(),
            "a closed worker stays closed"
        );
        assert!(
            s.read_with(&v, |s, _| s.current().and_then(|w| w.panes.clone()))
                .is_none()
        );
        assert!(s.read_with(&v, |s, _| pane(s)).is_none());
    }

    #[gpui::test]
    fn a_users_own_split_keeps_workers_out(cx: &mut TestAppContext) {
        let mut own = Node::main();
        own.split(
            MAIN,
            Zone::Right,
            "pane-own".into(),
            Leaf::Chat {
                session: "thoughts-tools".into(),
            },
        );
        let (_f, s, mut v) = setup(cx, Some(own.clone()));
        until(&s, &mut v, "the chat's agents", listed);
        assert_eq!(s.read_with(&v, |s, _| saved(s)), own);
    }

    #[gpui::test]
    fn steering_a_worker_sends_its_packet_once(cx: &mut TestAppContext) {
        let (_f, s, mut v) = setup(cx, None);
        until(&s, &mut v, "the worker pane", |s, _| pane(s).is_some());
        let view = s.read_with(&v, |s, _| pane(s).unwrap());
        view.update(&mut v, |view, cx| {
            view.type_steer("Use the smaller fixture", cx)
        });
        click(&mut v, "worker-pane-send-subagent-calculation");
        until(&s, &mut v, "the steer", |_, cx| !view.read(cx).steering().0);
        // The fixture can't confirm delivery, so the adjustment is kept.
        let (_, first, notice) = view.read_with(&v, |view, _| view.steering());
        let first = first.expect("an unconfirmed steer keeps its body");
        assert_eq!(first["packetId"], "subagent-calculation");
        assert_eq!(first["message"], "Use the smaller fixture");
        assert!(notice.starts_with("Delivery unconfirmed"), "{notice}");

        // Retry asks about the same adjustment, never a second one.
        view.update(&mut v, |view, cx| view.type_steer("Something else", cx));
        click(&mut v, "worker-pane-send-subagent-calculation");
        until(&s, &mut v, "the retry", |_, cx| !view.read(cx).steering().0);
        let (_, retried, _) = view.read_with(&v, |view, _| view.steering());
        assert_eq!(retried, Some(first));
    }
}
