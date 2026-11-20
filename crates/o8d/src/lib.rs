//! Delivery for stamped producer envelopes and daemon-owned global events.
#[cfg(unix)]
pub mod codex;
#[cfg(unix)]
pub mod child_spawn;

use serde_json::{json, Value};
use std::collections::VecDeque;
use tokio::sync::{broadcast, Mutex};

#[cfg(feature = "experimental-http")]
pub mod http;

#[cfg(feature = "experimental-ws")]
pub mod websocket;

#[cfg(feature = "experimental-ws")]
pub mod app;

#[cfg(feature = "experimental-mcp")]
pub mod mcp;

#[cfg(all(feature = "experimental-supervisor", target_os = "linux"))]
pub mod supervisor;

struct State {
    latest: u64,
    evicted_through: u64,
    log: VecDeque<Value>,
}

pub struct EventBus {
    epoch: String,
    limit: usize,
    state: Mutex<State>,
    live: broadcast::Sender<Vec<Value>>,
}

pub struct Replay {
    pub events: Vec<Value>,
    pub gap: Option<Value>,
    pub latest: u64,
}

impl EventBus {
    pub fn new(epoch: String, limit: usize) -> Self {
        let (live, _) = broadcast::channel(limit.max(4));
        Self {
            epoch,
            limit: limit.max(4),
            state: Mutex::new(State {
                latest: 0,
                evicted_through: 0,
                log: VecDeque::new(),
            }),
            live,
        }
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn listen(&self) -> broadcast::Receiver<Vec<Value>> {
        self.live.subscribe()
    }

    pub async fn latest(&self) -> u64 {
        self.state.lock().await.latest
    }

    /// Atomic stamped batch. Never reads accounts or executes commands.
    pub async fn publish(&self, events: Vec<Value>) -> Result<(), &'static str> {
        let mut state = self.state.lock().await;
        let mut previous = state.latest;
        for event in &events {
            let seq = event["seq"].as_u64().ok_or("invalid seq")?;
            let stream = event["stream"].as_str().ok_or("invalid stream")?;
            if seq <= previous
                || event["protocol"] != 1
                || !(stream == "global" || stream.starts_with("session:"))
                || !event["channel"].is_string()
                || !event["event"].is_string()
                || !event["ts"].is_string()
                || event.get("data").is_none()
            {
                return Err("invalid producer envelope");
            }
            previous = seq;
        }
        state.latest = previous;
        for event in &events {
            if event["delivery"] != "bootstrap" {
                state.log.push_back(event.clone());
            }
        }
        while state.log.len() > self.limit {
            if let Some(event) = state.log.pop_front() {
                state.evicted_through = event["seq"].as_u64().unwrap_or(state.evicted_through);
            }
        }
        // Send under the same lock so publication and replay cannot reorder the log.
        let public = events
            .into_iter()
            .filter(|event| event["delivery"] != "bootstrap")
            .collect::<Vec<_>>();
        if !public.is_empty() {
            let _ = self.live.send(public);
        }
        Ok(())
    }

    /// Reconcile a TS subscription barrier against actual Rust eviction. Gaps
    /// between sequence numbers can be private bootstrap or another stream;
    /// they do not prove a dropped public event in this process.
    pub async fn crossover(&self, stream: &str, since: u64) -> Option<(Vec<Value>, u64)> {
        let state = self.state.lock().await;
        if state.evicted_through > since {
            return None;
        }
        Some((
            state
                .log
                .iter()
                .filter(|event| {
                    event["stream"] == stream && event["seq"].as_u64().unwrap_or(0) > since
                })
                .cloned()
                .collect(),
            state.latest,
        ))
    }

    pub async fn replay(&self, stream: &str, since: Option<f64>, epoch: Option<&str>) -> Replay {
        let state = self.state.lock().await;
        let cursor = since.unwrap_or(0.0);
        let earliest = state
            .log
            .iter()
            .find(|event| event["stream"] == stream)
            .and_then(|event| event["seq"].as_u64());
        let gap = since.is_some()
            && (epoch != Some(self.epoch())
                || cursor > state.latest as f64
                || (cursor > 0.0 && earliest.is_none_or(|seq| cursor < seq as f64 - 1.0)));
        Replay {
            events: if gap {
                vec![]
            } else {
                state
                    .log
                    .iter()
                    .filter(|event| {
                        event["stream"] == stream
                            && event["seq"].as_u64().unwrap_or(0) as f64 > cursor
                    })
                    .cloned()
                    .collect()
            },
            gap: gap.then(|| {
                json!({"requestedSince": cursor,
                "earliestAvailable": earliest.unwrap_or(state.latest + 1)})
            }),
            latest: state.latest,
        }
    }
}
