//! Inline controls for the existing diff surface; no separate parser or renderer.
use super::*;
use crate::{composer::Composer, diff::File};
use gpui::{AnyElement, Entity};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
type Key = (String, usize);
pub(super) struct State {
    workspace: String,
    packet: Entity<Composer>,
    base: Entity<Composer>,
    selected_packet: Option<String>,
    skipped: BTreeSet<Key>,
    collapsed: BTreeSet<Key>,
    pending: Option<Value>,
}
impl State {
    pub(super) fn label(&self, doc: &Document) -> String {
        format!(
            "{} · {} files · HEAD {}",
            self.selected_packet.as_deref().unwrap_or("Read-only"),
            doc.files.len(),
            &doc.head[..doc.head.len().min(12)]
        )
    }
    fn new(workspace: String, cx: &mut Context<DiffSurface>) -> Self {
        Self {
            workspace,
            packet: cx.new(Composer::new),
            base: cx.new(Composer::new),
            selected_packet: None,
            skipped: BTreeSet::new(),
            collapsed: BTreeSet::new(),
            pending: None,
        }
    }
    fn key(file: &File, row: usize) -> Key {
        (
            file.path.clone(),
            file.lines[..=row]
                .iter()
                .filter(|line| line.kind == Kind::Hunk)
                .count()
                .saturating_sub(1),
        )
    }
    pub(super) fn rows(&self, file: &File) -> Vec<usize> {
        let mut hidden = false;
        let mut hunk = 0;
        file.lines
            .iter()
            .enumerate()
            .filter_map(|(i, line)| {
                if line.kind == Kind::Hunk {
                    hidden = self.collapsed.contains(&(file.path.clone(), hunk));
                    hunk += 1;
                    return Some(i);
                }
                (!hidden).then_some(i)
            })
            .collect()
    }
    fn patch(&self, doc: &Document) -> String {
        // Preserve exact Git file headers, quoting and no-newline markers. The
        // existing parsed files supply identity; this only selects raw hunks.
        let mut output = String::new();
        let mut header = String::new();
        let mut file = 0usize;
        let mut seen_file = false;
        let mut hunk = None;
        let mut emitted = false;
        let mut include = false;
        for raw in doc.source.split_inclusive('\n') {
            if raw.starts_with("diff --git ") {
                if seen_file {
                    file += 1;
                }
                seen_file = true;
                header.clear();
                hunk = None;
                emitted = false;
                include = false;
            }
            if raw.starts_with("@@ ") {
                let index = hunk.map_or(0, |i| i + 1);
                hunk = Some(index);
                include = doc
                    .files
                    .get(file)
                    .is_some_and(|f| !self.skipped.contains(&(f.path.clone(), index)));
                if include && !emitted {
                    output.push_str(&header);
                    emitted = true;
                }
            }
            if hunk.is_none() {
                header.push_str(raw);
            } else if include {
                output.push_str(raw);
            }
        }
        output
    }
    fn has_selection(&self, doc: &Document) -> bool {
        doc.files.iter().any(|file| {
            file.lines
                .iter()
                .filter(|line| line.kind == Kind::Hunk)
                .enumerate()
                .any(|(hunk, _)| !self.skipped.contains(&(file.path.clone(), hunk)))
        })
    }
}
fn packet_target(client: &Client, workspace: &str, id: &str) -> Result<Target, String> {
    let state: Value = client.get("/api/orchestrator/state", &[])?;
    let packet = state["mission"]["packets"]
        .as_array()
        .and_then(|items| items.iter().find(|packet| packet["id"] == id))
        .ok_or("Packet unavailable")?;
    let path = packet["lane"]["worktreePath"]
        .as_str()
        .ok_or("Packet has no readable worktree")?;
    let same_path = |a: &str, b: &str| match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    };
    if !packet["workspaceTargetPath"]
        .as_str()
        .is_some_and(|root| same_path(root, workspace))
        && !same_path(path, workspace)
    {
        return Err("Packet belongs to another workspace".into());
    }
    let lane_id = packet["lane"]["laneId"]
        .as_str()
        .ok_or("Packet has no lane")?;
    let lane_id: String = url::form_urlencoded::byte_serialize(lane_id.as_bytes()).collect();
    let detail: Value = client.get(&format!("/api/lanes/{lane_id}"), &[])?;
    let lane = &detail["lane"];
    if lane["packetId"] != id
        || !lane["worktreePath"]
            .as_str()
            .is_some_and(|root| same_path(root, path))
    {
        return Err("Packet lane changed. Reopen the packet.".into());
    }
    let base = lane["baseBranch"]
        .as_str()
        .filter(|base| !base.trim().is_empty())
        .ok_or("Packet lane has no base branch")?;
    if crate::viewer_guard::sensitive(base) || crate::viewer_guard::sensitive(path) {
        return Err("Sensitive packet metadata hidden".into());
    }
    Ok(Target::Worktree {
        path: path.into(),
        base: Some(base.into()),
        file: None,
    })
}
impl DiffSurface {
    #[cfg(test)]
    pub(crate) fn inline_idle(&self) -> bool {
        self.ready && !self.busy
    }
    pub(crate) fn inline(
        client: Client,
        target: Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let workspace = match &target {
            Target::Worktree { path, .. } => path.clone(),
            _ => String::new(),
        };
        let mut view = Self::new(client, target, window, cx);
        view.inline = Some(State::new(workspace, cx));
        view
    }
    pub(crate) fn shell_focus(&self, window: &mut Window) {
        self.focus.focus(window);
    }
    pub(super) fn inline_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let state = self.inline.as_ref().unwrap();
        let can_copy = self.ready
            && !self.document.truncated
            && !self.document.unsupported
            && state.has_selection(&self.document);
        let can_merge = can_copy
            && !self.busy
            && state.selected_packet.as_deref() == Some(state.packet.read(cx).text.trim());
        div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .p(px(8.))
            .items_center()
            .child("Base")
            .child(
                div()
                    .debug_selector(|| "inline-base".into())
                    .w(px(120.))
                    .child(state.base.clone()),
            )
            .child(
                button("inline-compare", "Compare", false).on_click(cx.listener(|s, _, _, cx| {
                    if s.busy {
                        return;
                    }
                    let base = s
                        .inline
                        .as_ref()
                        .unwrap()
                        .base
                        .read(cx)
                        .text
                        .trim()
                        .to_owned();
                    if let Target::Worktree {
                        base: target_base, ..
                    } = &mut s.target
                    {
                        *target_base = (!base.is_empty()).then_some(base);
                    }
                    s.load(cx);
                })),
            )
            .child("Packet")
            .child(
                div()
                    .debug_selector(|| "inline-packet".into())
                    .w(px(210.))
                    .child(state.packet.clone()),
            )
            .child(
                button("inline-open-packet", "Open packet", false)
                    .on_click(cx.listener(|s, _, _, cx| s.inline_packet(cx))),
            )
            .child(
                button("inline-all", "Accept all", false).on_click(cx.listener(|s, _, _, cx| {
                    s.inline.as_mut().unwrap().skipped.clear();
                    cx.notify();
                })),
            )
            .child(
                button("inline-none", "Skip all", false).on_click(cx.listener(|s, _, _, cx| {
                    let state = s.inline.as_mut().unwrap();
                    state.skipped = s
                        .document
                        .files
                        .iter()
                        .flat_map(|file| {
                            file.lines
                                .iter()
                                .enumerate()
                                .filter(|(_, line)| line.kind == Kind::Hunk)
                                .map(move |(i, _)| State::key(file, i))
                        })
                        .collect();
                    cx.notify();
                })),
            )
            .child(
                button("inline-copy", "Copy patch", false)
                    .when(!can_copy, |v| {
                        v.text_color(theme().text_muted)
                            .cursor(gpui::CursorStyle::Arrow)
                    })
                    .on_click(cx.listener(|s, _, _, cx| {
                        if !s.ready || s.document.truncated || s.document.unsupported {
                            return;
                        }
                        let patch = s.inline.as_ref().unwrap().patch(&s.document);
                        if !patch.is_empty() {
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(patch));
                            s.notice = "Patch copied".into();
                            cx.notify();
                        }
                    })),
            )
            .when(state.selected_packet.is_some(), |v| {
                v.child(
                    button(
                        "inline-merge",
                        if self.busy && state.pending.is_some() {
                            "Merging…"
                        } else if state.pending.is_some() {
                            "Retry merge"
                        } else {
                            "Merge lane"
                        },
                        false,
                    )
                    .when(!can_merge, |v| {
                        v.text_color(theme().text_muted)
                            .cursor(gpui::CursorStyle::Arrow)
                    })
                    .on_click(cx.listener(|s, _, _, cx| s.inline_merge(cx))),
                )
            })
            .into_any_element()
    }
    fn inline_packet(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let state = self.inline.as_ref().unwrap();
        if state.pending.is_some() {
            self.notice = "Resolve the pending merge first".into();
            cx.notify();
            return;
        }
        let id = state.packet.read(cx).text.trim().to_owned();
        let workspace = state.workspace.clone();
        let client = self.client.clone();
        self.busy = true;
        self.notice = "Reading packet worktree…".into();
        let task = cx.background_executor().spawn(async move {
            packet_target(&client, &workspace, &id).map(|target| (id, target))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.busy = false;
                match result {
                    Ok((id, mut target)) => {
                        let base = s
                            .inline
                            .as_ref()
                            .unwrap()
                            .base
                            .read(cx)
                            .text
                            .trim()
                            .to_owned();
                        if let Target::Worktree {
                            base: comparison, ..
                        } = &mut target
                        {
                            if !base.is_empty() {
                                *comparison = Some(base);
                            } else if let Some(base) = comparison.as_ref() {
                                s.inline.as_ref().unwrap().base.update(cx, |input, cx| {
                                    input.clear(cx);
                                    input.text = base.clone();
                                    cx.notify();
                                });
                            }
                        }
                        s.inline.as_mut().unwrap().selected_packet = Some(id);
                        s.target = target;
                        s.load(cx);
                    }
                    Err(error) => {
                        s.inline.as_mut().unwrap().selected_packet = None;
                        s.notice = error;
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn inline_hunk(&self, row: usize, cx: &mut Context<Self>) -> AnyElement {
        let state = self.inline.as_ref().unwrap();
        let file = &self.document.files[self.selected];
        let key = State::key(file, row);
        let index = key.1;
        let skipped = state.skipped.contains(&key);
        let collapsed = state.collapsed.contains(&key);
        let collapse_key = key.clone();
        div()
            .flex()
            .gap(px(4.))
            .child(
                div()
                    .id(("inline-hunk", index))
                    .debug_selector(move || format!("inline-hunk-{index}"))
                    .cursor_pointer()
                    .px(px(4.))
                    .bg(theme().surface_raised)
                    .child(if skipped { "Skipped" } else { "Included" })
                    .on_click(cx.listener(move |s, _, _, cx| {
                        let state = s.inline.as_mut().unwrap();
                        if !state.skipped.remove(&key) {
                            state.skipped.insert(key.clone());
                        }
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .id(("inline-collapse", index))
                    .debug_selector(move || format!("inline-collapse-{index}"))
                    .cursor_pointer()
                    .px(px(4.))
                    .bg(theme().surface_raised)
                    .child(if collapsed { "Expand" } else { "Collapse" })
                    .on_click(cx.listener(move |s, _, _, cx| {
                        let state = s.inline.as_mut().unwrap();
                        if !state.collapsed.remove(&collapse_key) {
                            state.collapsed.insert(collapse_key.clone());
                        }
                        cx.notify();
                    })),
            )
            .into_any_element()
    }
    fn inline_merge(&mut self, cx: &mut Context<Self>) {
        if self.busy || !self.ready || self.document.truncated || self.document.unsupported {
            return;
        }
        let state = self.inline.as_mut().unwrap();
        if !state.has_selection(&self.document) {
            return;
        }
        let Some(packet) = state
            .selected_packet
            .clone()
            .filter(|id| state.packet.read(cx).text.trim() == id)
        else {
            return;
        };
        let workspace = state.workspace.clone();
        let target = self.target.clone();
        let client = self.client.clone();
        let body=state.pending.get_or_insert_with(||json!({"packetId":packet,"expectedHeadSha":self.document.head,"idempotencyKey":format!("o8-next-inline-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())})).clone();
        self.busy = true;
        self.notice = "Merging lane…".into();
        let task=cx.background_executor().spawn(async move {
            let current=packet_target(&client,&workspace,&packet)?;
            if !matches!((&current,&target),(Target::Worktree{path:a,..},Target::Worktree{path:b,..}) if a==b){return Err("Packet worktree changed. Reopen the packet.".to_owned());}
            Ok(client.inline_merge_receipt(&body))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.busy = false;
                match result {
                    Err(error) => {
                        s.inline.as_mut().unwrap().pending = None;
                        s.notice = error;
                    }
                    Ok(Err(error)) => s.notice = error,
                    Ok(Ok((status, data))) => {
                        s.inline.as_mut().unwrap().pending = None;
                        s.notice = if !(200..300).contains(&status) || data["ok"] != true {
                            data["error"]
                                .as_str()
                                .or(data["error"]["message"].as_str())
                                .unwrap_or("Merge refused")
                                .into()
                        } else if data["result"]["merged"] == true {
                            "Merged".into()
                        } else {
                            data["result"]["note"]
                                .as_str()
                                .or(data["result"]["status"].as_str())
                                .unwrap_or("Merge accepted")
                                .into()
                        };
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
