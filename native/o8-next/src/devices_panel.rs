//! Port of classic DevicePanel, DeviceAgentControls and DeviceControllerRoster.
//! Inspection is passive; only explicit actions start or install helpers.
mod transport;
mod view;
use crate::client::Client;
use gpui::{Context, FocusHandle};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub struct DevicesPanel {
    client: Client,
    state: Option<Value>,
    error: Option<String>,
    pending: bool,
    mutating: bool,
    active: bool,
    generation: u64,
    focus: FocusHandle,
}
impl DevicesPanel {
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        Self {
            client,
            state: None,
            error: None,
            pending: false,
            mutating: false,
            active: false,
            generation: 0,
            focus: cx.focus_handle(),
        }
    }
    pub fn focus(&self, window: &mut gpui::Window) {
        self.focus.focus(window);
    }
    pub fn activate(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active == active {
            return;
        }
        self.active = active;
        if active {
            self.read(None, cx);
        } else {
            self.generation += 1;
            self.pending = false;
            self.mutating = false;
        }
        cx.notify();
    }
    fn phase(&self) -> &str {
        self.state
            .as_ref()
            .and_then(|s| s["phase"].as_str())
            .unwrap_or("")
    }
    fn running(&self) -> bool {
        self.phase() == "running"
            && self
                .state
                .as_ref()
                .is_some_and(|s| s["embedUrl"].as_str().is_some())
    }
    fn busy(&self) -> bool {
        self.mutating
            || (self.pending && self.state.is_none())
            || matches!(self.phase(), "installing" | "starting")
    }

    fn accept(&mut self, mut value: Value) {
        if let Some(old) = &self.state
            && revision(old) > revision(&value)
        {
            value["controllers"] = old["controllers"].clone();
            value["controllerRevision"] = old["controllerRevision"].clone();
        }
        self.state = Some(value);
        self.error = None;
    }
    fn read(&mut self, action: Option<Value>, cx: &mut Context<Self>) {
        if !self.active || (action.is_some() && self.busy()) {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.pending = true;
        self.mutating = action.is_some();
        if action.is_some() {
            self.error = None;
        }
        let client = self.client.clone();
        let (send, receive) = async_channel::bounded(1);
        std::thread::spawn(move || {
            let _ = send.send_blocking(transport::read(&client, action));
        });
        cx.spawn(async move |this, cx| {
            let Ok(result) = receive.recv().await else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                if !this.active || generation != this.generation {
                    return;
                }
                this.pending = false;
                this.mutating = false;
                match result {
                    Ok(state) => this.accept(state),
                    Err(error) => this.error = Some(error),
                }
                this.schedule(cx);
                cx.notify();
            });
        })
        .detach();
        // The deadline includes body reading and closes input even if the transport hangs.
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(15))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.active && this.pending && generation == this.generation {
                    this.generation += 1;
                    this.pending = false;
                    this.mutating = false;
                    this.error = Some(transport::TIMEOUT.into());
                    this.schedule(cx);
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }
    fn schedule(&self, cx: &mut Context<Self>) {
        if !self.active || !matches!(self.phase(), "installing" | "starting" | "running") {
            return;
        }
        let generation = self.generation;
        let delay = if self.error.is_some() {
            30_000
        } else if self.running() {
            5_000
        } else {
            1_500
        };
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(delay))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.active && !this.pending && generation == this.generation {
                    this.read(None, cx);
                }
            });
        })
        .detach();
    }

    fn action(&mut self, action: &str, cx: &mut Context<Self>) {
        if !self.busy() {
            self.read(Some(json!({"action":action})), cx);
        }
    }
}

fn revision(state: &Value) -> u64 {
    state["controllerRevision"].as_u64().unwrap_or(0)
}
fn rows<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value[key].as_array().into_iter().flatten()
}
fn text(value: &Value) -> String {
    value.as_str().unwrap_or("").to_owned()
}
