//! Dispatch from the existing Activity controls.
use super::*;

impl ActivityPane {
    pub(in super::super) fn act(&mut self, action: Action, cx: &mut Context<Self>) {
        match &action {
            Action::Hold(row, _) | Action::Lane(row, _) | Action::Close(row) => {
                self.packet.action = Some(row.id.clone())
            }
            Action::StopMission => self.packet.action = None,
            _ => {}
        }
        match action {
            Action::Recovery(row, kind) => self.recovery_ask(row, kind, cx),
            Action::RecoveryConfirm(row) => self.recovery_confirm(&row.id, cx),
            Action::RecoveryCancel => self.packet.recovery.ask = None,
            Action::BackToFeed => self.commit = None,
            Action::Packet(command) => self.packet_act(command, cx),
            Action::Proposals => {self.proposals.open = !self.proposals.open; self.saved.proposals_open=Some(self.proposals.open); self.mark_proposals_seen(cx); self.remember_view(cx);},
            Action::ProposalDetail(id) => {if !self.proposals.expanded.remove(&id){self.proposals.expanded.insert(id);}},
            Action::ProposalDecision(id,accept) => self.proposal_action(id,accept,cx),
            Action::RetryProposals => self.load_proposals(cx),
            Action::Filter(filter) => { self.filter = filter; self.expanded = None; }
            Action::ScopeMenu(open) => self.scope_menu = open,
            Action::Scope(scope) => {
                self.remember_view(cx);
                self.scope_menu = false;
                self.stop_armed = None;
                self.packet.recovery.ask = None;
                self.closing = None;
                self.archiving = None;
                self.close_stage = None;
                self.scope = scope;
                self.restore_view();
                if let Some(y)=self.restore_y {self.scroll.set_offset(gpui::point(gpui::px(0.),gpui::px(y)));} self.generation += 1; self.loading = false;
                self.packet.reads.clear(); self.packet.editor = None; self.rows.clear(); self.errors.clear(); self.details.clear(); self.keyboard = None; self.load(cx);
            }
            Action::Refresh => {
                // A receipt route replays the same body, which only reads the
                // persisted outcome; anything else settles from the fresh feed.
                if !self.pending
                    && let Some((method, path, body)) = self.unsettled.take()
                    && RECEIPTS.contains(&path)
                {
                    self.mutate(method, path, body, cx);
                }
                self.packet.reads.clear(); self.refresh_feed(true,true,cx); self.load_dossiers(cx); self.load_proposals(cx);
            },
            Action::Attention => {
                self.attention_open = !self.attention_open;
                self.mark_proposals_seen(cx);
            }
            Action::Dossiers => self.decisions.open = !self.decisions.open,
            Action::DossierHistory(id) => self.decisions.expanded = if self.decisions.expanded.as_ref() == Some(&id) { None } else { Some(id) },
            Action::DossierDecision(id, action) => self.dossier_decision(id, action, cx),
            Action::RetryDossiers => self.load_dossiers(cx),
            Action::Expand(row) => {
                if self.expanded.as_ref() == Some(&row.key()) { self.expanded = None; }
                else { self.expanded = Some(row.key()); if row.kind == "packet" { self.packet_read(row,false,cx); } else { self.detail(row,false,cx); } }
            }
            Action::RetryDetail(row) => self.detail(row,true,cx),
            Action::Link(url) => crate::external_open::url(cx, &url),
            Action::Open(row) => {
                if row.kind == "commit" {
                    cx.emit(ActivityEvent::Commit(row));
                } else if row.kind == "pr" && self.pr_browser == Some(true) {
                    if let Some(url) = row.url() { crate::external_open::url(cx, &url); }
                } else if let Some(url) = row.url() {
                    cx.emit(ActivityEvent::Open(url));
                }
            }
            Action::Worker(key) => cx.emit(ActivityEvent::Worker(key)),
            Action::Hold(row,held) => self.mutate("PATCH","/api/orchestrator/state", json!({"packetId":row.id,"updates":{"queueState":if held {"held"}else{"queued"},"blockedReason":if held {Some("Held by operator")}else{None}}}),cx),
            Action::StopMission => {
                let mission = feed::text(&self.mission,"missionId");
                if mission.is_empty() { return; }
                // Stopping holds every packet and sits beside Refresh, so one
                // press only asks. A second press while it asks stops (#5975).
                // The question is about one mission; an answer for another
                // mission asks again.
                let answered = self.stop_armed.take().is_some_and(|(_, about)| about == mission);
                if !answered {
                    self.stop_asked += 1;
                    let asked = self.stop_asked;
                    self.stop_armed = Some((asked, mission));
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(STOP_ASKS_FOR).await;
                        let _ = this.update(cx, |this, cx| {
                            if this.stop_armed.as_ref().is_some_and(|(at, _)| *at == asked) {
                                this.stop_armed = None;
                                cx.notify();
                            }
                        });
                    })
                    .detach();
                    cx.notify();
                    return;
                }
                // Reuse the same identity after an unconfirmed transport result.
                let (_,identity) = self.stop_identity.get_or_insert_with(|| (mission.clone(),format!("next-stop-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos())));
                let identity = identity.clone();
                self.mutate("POST","/api/orchestrator/stop-mission",json!({"missionId":mission,"idempotencyKey":identity}),cx);
            }
            Action::Lane(row, verb) => {
                if verb == "merge" && packet_merge::packet_id(&row).is_some() {
                    self.merge_packet(&row, cx);
                    return;
                }
                let lane = feed::text(&row.data["lane"], "laneId");
                if lane.is_empty() { return; }
                let mut body = json!({"verb": verb, "laneId": lane});
                match verb {
                    "resume" => { body["message"] = json!("Continue the previous task."); body["actor"] = json!("user"); }
                    "stop" => body["actor"] = json!("user"),
                    "create_pr" => body["commitMessage"] = json!("Auto-commit from lane"),
                    _ => body["commitMessage"] = json!(format!("Merge lane: {}", feed::text(&row.data, "title"))),
                }
                self.mutate("POST", "/api/lanes", body, cx);
            }
            Action::CloseAsk(packet) => { self.closing = packet; self.close_reason = CLOSE_REASONS[0].0; }
            Action::ArchiveAsk(packet) => self.archiving = packet,
            Action::StopArchive(row) => {
                if self.pending { return; }
                self.archiving = None;
                self.archive_after_stop = Some(row.id.clone());
                self.act(Action::Lane(row, "stop"), cx);
                // A refused stop must not leave the archive armed for the next
                // decision that succeeds.
                if !self.pending {
                    self.archive_after_stop = None;
                }
            }
            Action::CloseReason(reason) => self.close_reason = reason,
            Action::Close(row) => {
                if self.pending { return; }
                let mutation = format!("next-close-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
                self.mutate("POST", "/api/orchestrator/discard-packet", json!({"packetId": row.id, "disposition": self.close_reason, "clientMutationId": mutation}), cx);
                // A refused close keeps its notice and leaves the confirm usable.
                if !self.pending { return; }
                // The stage shows on the confirm itself, as in classic.
                self.notice.clear();
                self.close_stage = Some("Closing packet…");
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_secs(3)).await;
                    let _ = this.update(cx, |this, cx| {
                        if this.close_stage.is_some() && this.closing.as_deref() == Some(row.id.as_str()) {
                            this.close_stage = Some("Preserving work and archiving…");
                            this.changed(cx);
                        }
                    });
                })
                .detach();
            }
        }
        self.remember_view(cx);
        self.changed(cx);
    }
}
