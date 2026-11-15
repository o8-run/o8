//! Local review of immutable plugin drafts. The existing server owns admission.
use crate::{client::Client, theme::current as theme};
use gpui::{Context, FocusHandle, KeyDownEvent, Window, prelude::*};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

#[path = "plugin_tasks_view.rs"]
mod view;
const LIST: &str = "/api/plugins/task-drafts";
const CONTROL: &str = "/api/plugins/task-drafts/control";
const HELD: &str = "Tasks are held. Sign in to the same o8 account and refresh.";
const UNCERTAIN: &str =
    "The outcome is held or uncertain. Inspect this task before taking another action.";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    max_requests: u32,
    max_output_tokens: u32,
    cost_usd: f64,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    objective: String,
    runtime: String,
    model: String,
    effort: String,
    work_mode: String,
    machine_id: String,
    project_id: String,
    repo_id: String,
    allowed_files: Vec<String>,
    evidence: Vec<String>,
    sealed_task_contract: Value,
    provider: Option<Provider>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    task_id: String,
    contract_hash: String,
    attempt_id: String,
    state: String,
    completed: bool,
    stopped: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Draft {
    task_id: String,
    contract_hash: String,
    session_current: bool,
    contract: Contract,
    revision: String,
    rules_digest: String,
    execution: Option<Receipt>,
    execution_error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct List {
    ok: bool,
    account_id: String,
    drafts: Vec<Draft>,
}
#[derive(Clone, PartialEq, Eq)]
struct Handle {
    account: String,
    task: String,
    hash: String,
}
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Action {
    Launch,
    Inspect,
    Stop,
}
impl Action {
    fn verb(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Inspect => "inspect",
            Self::Stop => "stop",
        }
    }
    fn busy(self) -> &'static str {
        match self {
            Self::Launch => "Checking and starting the reviewed attempt",
            Self::Inspect => "Inspecting the persisted attempt",
            Self::Stop => "Stopping the attempt",
        }
    }
}

pub(crate) struct Tasks {
    client: Client,
    account: Option<String>,
    drafts: Vec<Draft>,
    selected: Option<String>,
    stop_handle: Option<Handle>,
    uncertain: HashSet<String>,
    busy: Option<Action>,
    reading: bool,
    loaded: bool,
    generation: u64,
    message: Option<String>,
    confirming: bool,
    confirmation_target: Option<Handle>,
    expanded: bool,
    focus: FocusHandle,
    controls: HashMap<&'static str, FocusHandle>,
    order: Vec<&'static str>,
}
impl Tasks {
    pub(crate) fn new(client: Client, cx: &mut Context<Self>) -> Self {
        Self {
            client,
            account: None,
            drafts: vec![],
            selected: None,
            stop_handle: None,
            uncertain: HashSet::new(),
            busy: None,
            reading: false,
            loaded: false,
            generation: 0,
            message: None,
            confirming: false,
            confirmation_target: None,
            expanded: false,
            focus: cx.focus_handle(),
            controls: HashMap::new(),
            order: vec![],
        }
    }
    fn draft(&self) -> Option<&Draft> {
        self.drafts
            .iter()
            .find(|draft| Some(&draft.task_id) == self.selected.as_ref())
            .or(self.drafts.first())
    }
    fn handle(&self) -> Option<Handle> {
        let draft = self.draft()?;
        Some(Handle {
            account: self.account.clone()?,
            task: draft.task_id.clone(),
            hash: draft.contract_hash.clone(),
        })
    }
    fn has_attempt(&self) -> bool {
        self.draft().is_some_and(|draft| {
            draft.execution.is_some()
                || draft.execution_error.is_some()
                || self.uncertain.contains(&draft.task_id)
        })
    }
    fn available(&self, action: Action) -> bool {
        if self.reading || self.busy.is_some() {
            return false;
        }
        if action == Action::Stop {
            return self.stop_target().is_some();
        }
        self.handle().is_some()
            && self.draft().is_some_and(|draft| draft.session_current)
            && if action == Action::Launch {
                !self.has_attempt()
            } else {
                self.has_attempt()
            }
    }
    fn stop_target(&self) -> Option<Handle> {
        let safe = self.stop_handle.as_ref().filter(|handle| {
            self.account
                .as_ref()
                .is_none_or(|account| account == &handle.account)
        });
        match self.draft() {
            Some(draft)
                if draft
                    .execution
                    .as_ref()
                    .is_some_and(|receipt| !receipt.stopped && !receipt.completed) =>
            {
                self.handle()
            }
            Some(draft) if draft.execution.is_none() => {
                safe.filter(|handle| handle.task == draft.task_id).cloned()
            }
            Some(_) => None,
            None => safe.cloned(),
        }
    }
    fn remember_attempt(&mut self) {
        if let Some(receipt) = self.draft().and_then(|draft| draft.execution.as_ref()) {
            if receipt.stopped || receipt.completed {
                if self
                    .stop_handle
                    .as_ref()
                    .is_some_and(|handle| handle.task == receipt.task_id)
                {
                    self.stop_handle = None;
                }
            } else {
                self.stop_handle = self.handle();
            }
        }
    }
    pub(super) fn load(&mut self, cx: &mut Context<Self>) {
        if self.reading || self.busy.is_some() {
            return;
        }
        self.reading = true;
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let list: List =
                super::providers::call(&client, "GET", LIST, Value::Null, Duration::from_secs(45))?;
            if !list.ok || list.account_id.trim().is_empty() || !list.drafts.iter().all(valid) {
                return Err(HELD.into());
            }
            Ok::<List, String>(list)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.reading = false;
                this.loaded = true;
                match result {
                    Ok(list) => {
                        if this
                            .stop_handle
                            .as_ref()
                            .is_some_and(|handle| handle.account != list.account_id)
                        {
                            this.stop_handle = None;
                            this.clear_confirmation();
                        }
                        this.account = Some(list.account_id);
                        this.drafts = list.drafts;
                        this.message = None;
                        this.remember_attempt();
                    }
                    Err(_) => {
                        this.account = None;
                        this.drafts.clear();
                        this.message = Some(HELD.into());
                    }
                }
                if this.confirming && this.confirmation_target != this.stop_target() {
                    this.clear_confirmation();
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn clear_confirmation(&mut self) {
        self.confirming = false;
        self.confirmation_target = None;
    }
    pub(super) fn select(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.reading || self.busy.is_some() {
            return;
        }
        if let Some(draft) = self.drafts.get(index) {
            self.selected = Some(draft.task_id.clone());
            self.clear_confirmation();
            self.expanded = false;
            self.message = None;
            self.remember_attempt();
            cx.notify();
        }
    }
    pub(crate) fn confirm(&mut self, confirm: bool, cx: &mut Context<Self>) {
        if self.available(Action::Stop) {
            self.confirming = confirm;
            self.confirmation_target = confirm.then(|| self.stop_target()).flatten();
            cx.notify();
        }
    }
    pub(super) fn control(&mut self, action: Action, cx: &mut Context<Self>) {
        if !self.available(action) || (action == Action::Stop && !self.confirming) {
            return;
        }
        let target = if action == Action::Stop {
            self.stop_target()
        } else {
            self.handle()
        };
        let Some(target) = target else {
            return;
        };
        if action == Action::Stop && self.confirmation_target.as_ref() != Some(&target) {
            self.clear_confirmation();
            cx.notify();
            return;
        }
        if action == Action::Launch {
            self.uncertain.insert(target.task.clone());
            self.stop_handle = Some(target.clone());
        }
        self.busy = Some(action);
        self.message = None;
        let generation = self.generation;
        let client = self.client.clone();
        let requested = target.clone();
        let task = cx.background_executor().spawn(async move {
            let value: Value = super::providers::call(&client, "POST", CONTROL,
                json!({"action":action.verb(),"taskId":requested.task,"contractHash":requested.hash}), Duration::from_secs(45))?;
            let receipt: Receipt = serde_json::from_value(value["execution"].clone()).map_err(|_| UNCERTAIN.to_owned())?;
            if value["ok"] != true || receipt.task_id != requested.task || receipt.contract_hash != requested.hash
                || receipt.attempt_id.is_empty() || receipt.state.is_empty() { return Err(UNCERTAIN.into()); }
            Ok::<Receipt, String>(receipt)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.busy = None;
                match result {
                    Ok(receipt) => {
                        this.message = Some(outcome(&receipt));
                        for draft in &mut this.drafts {
                            if draft.task_id == target.task && draft.contract_hash == target.hash {
                                draft.execution = Some(receipt.clone());
                                draft.execution_error = None;
                            }
                        }
                        this.stop_handle =
                            (!receipt.stopped && !receipt.completed).then_some(target);
                        this.clear_confirmation();
                    }
                    Err(_) => this.message = Some(UNCERTAIN.into()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(crate) fn key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if event.keystroke.key == "escape" {
            if self.confirming {
                if self.busy.is_none() && !self.reading {
                    self.clear_confirmation();
                    cx.notify();
                }
                return true;
            }
            if self.expanded {
                self.expanded = false;
                cx.notify();
                return true;
            }
        }
        if event.keystroke.key == "tab" {
            if let Some(at) = self
                .order
                .iter()
                .position(|id| self.controls[id].is_focused(window))
            {
                let next = if event.keystroke.modifiers.shift {
                    at.checked_sub(1)
                } else {
                    Some(at + 1)
                };
                if let Some(next) = next.and_then(|at| self.order.get(at)) {
                    self.controls[next].focus(window);
                    return true;
                }
            }
        }
        false
    }
}
fn outcome(receipt: &Receipt) -> String {
    format!(
        "Attempt {}: {}. Review the worker evidence before using its result.",
        receipt.attempt_id, receipt.state
    )
}
fn valid(draft: &Draft) -> bool {
    !draft.task_id.is_empty()
        && draft.contract_hash.len() == 64
        && draft
            .contract_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        && !draft.contract.objective.trim().is_empty()
        && draft.contract.work_mode == "read-only"
        && !draft.contract.allowed_files.is_empty()
        && !draft.contract.evidence.is_empty()
        && draft.contract.sealed_task_contract.is_object()
        && draft.execution.as_ref().is_none_or(|receipt| {
            receipt.task_id == draft.task_id && receipt.contract_hash == draft.contract_hash
        })
}

#[cfg(test)]
#[path = "plugin_tasks_tests.rs"]
mod tests;
