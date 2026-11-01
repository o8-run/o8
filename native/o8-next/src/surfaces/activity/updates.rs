//! Classic's single-flight invalidation, excluding transcript-only batches.
use super::*;
use crate::transport::{self, Incoming, Subscription};

#[derive(Default)]
pub(in super::super) struct Updates {
    pub subscription: Option<Subscription>,
    pub queued: bool,
    pub fresh: bool,
    pub manual: bool,
    pub aux_updated: Option<Instant>,
    seen: bool,
}

impl ActivityPane {
    pub(crate) fn sync_updates(&mut self, visible: bool, cx: &mut Context<Self>) {
        if !visible {
            self.updates.subscription = None;
            self.updates.queued = false;
            return;
        }
        if self.updates.subscription.is_none() {
            self.updates.subscription = Some(transport::subscribe_global(self.client.clone()));
            // A pane reopened after a quiet period must revalidate local history too.
            if self.updates.seen {
                self.refresh_feed(false, false, cx);
            }
            self.updates.seen = true;
        }
        let invalidated = self
            .updates
            .subscription
            .as_ref()
            .is_some_and(|subscription| {
                subscription
                    .receiver
                    .try_iter()
                    .take(64)
                    .fold(false, |dirty, incoming| {
                        matches!(incoming, Incoming::Frame(ref frame) if invalidates(frame))
                            || dirty
                    })
            });
        if invalidated {
            self.refresh_feed(true, false, cx);
            self.load_dossiers(cx);
            self.load_proposals(cx);
        }
    }

    pub(super) fn refresh_feed(&mut self, fresh: bool, manual: bool, cx: &mut Context<Self>) {
        self.updates.fresh |= fresh;
        self.updates.manual |= manual;
        self.load(cx);
    }
}

fn invalidates(frame: &Value) -> bool {
    if frame["channel"] == "system" {
        return frame["event"] == "connected";
    }
    if frame["channel"] == "realtime" && frame["event"] == "batch" {
        return !frame["data"]["events"].as_array().is_some_and(|events| {
            !events.is_empty()
                && events.iter().all(|event| {
                    event["channel"] == "history" && event["event"] == "history.snapshot"
                        || event["type"] == "history.snapshot"
                })
        });
    }
    matches!(
        frame["channel"].as_str(),
        Some("agent-lifecycle" | "lane-lifecycle" | "orchestrator-threads")
    )
}
