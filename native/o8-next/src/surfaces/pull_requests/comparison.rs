use super::*;
use crate::theme::current as theme;
use serde_json::{Value, json};

fn background<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> async_channel::Receiver<T> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send_blocking(work());
    });
    rx
}
struct Candidate {
    packet: Value,
    files: Value,
    preview: Result<Value, String>,
    patches: std::collections::HashMap<String, String>,
}
pub(super) struct Compare {
    client: crate::client::Client,
    candidates: Vec<Candidate>,
    loading: bool,
    busy: bool,
    confirmation: Option<String>,
    error: String,
    scroll: gpui::ScrollHandle,
}
impl Compare {
    pub(super) fn new(client: crate::client::Client, cx: &mut Context<Self>) -> Self {
        let mut s = Self {
            client,
            candidates: vec![],
            loading: false,
            busy: false,
            confirmation: None,
            error: String::new(),
            scroll: Default::default(),
        };
        s.load(cx);
        s
    }
    pub(super) fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.busy || self.confirmation.is_some() {
            return;
        }
        self.loading = true;
        let client = self.client.clone();
        let rx = background(move || -> Result<Vec<Candidate>, String> {
            let state: Value = client.get("/api/orchestrator/state", &[])?;
            let mission = &state["mission"];
            let complete = |p: &Value| {
                p["review"].is_object()
                    || matches!(
                        p["status"].as_str(),
                        Some("awaiting_review" | "released" | "archived" | "failed")
                    )
            };
            let packets = mission["packets"].as_array().cloned().unwrap_or_default();
            let groups = mission["activeComparisonGroups"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let group = groups
                .iter()
                .map(|id| {
                    packets
                        .iter()
                        .filter(|p| p["comparisonGroupId"] == *id)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .find(|p| !p.is_empty() && p.iter().all(complete))
                .unwrap_or_default();
            group
                .into_iter()
                .map(|packet| {
                    let root = packet["lane"]["worktreePath"]
                        .as_str()
                        .or(packet["lane"]["repoPath"].as_str())
                        .unwrap_or("");
                    let files = if root.is_empty() {
                        json!({"changedFiles":[]})
                    } else {
                        client.get::<Value>(
                            "/api/orchestrator/comparison-diff",
                            &[("worktree", root), ("base", "main")],
                        )?
                    };
                    let preview = client.pr_preview(packet["id"].as_str().unwrap_or(""));
                    Ok(Candidate {
                        packet,
                        files,
                        preview,
                        patches: Default::default(),
                    })
                })
                .collect()
        });
        cx.spawn(async move |this, cx| {
            if let Ok(result) = rx.recv().await {
                let _ = this.update(cx, |s, cx| {
                    s.loading = false;
                    match result {
                        Ok(mut v) => {
                            for candidate in &mut v {
                                if let Some(old) = s.candidates.iter_mut().find(|old| {
                                    old.packet == candidate.packet
                                        && old.files == candidate.files
                                        && old.preview == candidate.preview
                                }) {
                                    candidate.patches = std::mem::take(&mut old.patches);
                                }
                            }
                            s.candidates = v;
                            s.error.clear()
                        }
                        Err(e) => s.error = e,
                    }
                    cx.notify()
                });
            }
        })
        .detach();
    }
    fn expand(&mut self, index: usize, path: String, cx: &mut Context<Self>) {
        let Some(c) = self.candidates.get_mut(index) else {
            return;
        };
        if c.patches.remove(&path).is_some() {
            cx.notify();
            return;
        }
        c.patches.insert(path.clone(), "Reading diff…".into());
        let root = c.packet["lane"]["worktreePath"]
            .as_str()
            .or(c.packet["lane"]["repoPath"].as_str())
            .unwrap_or("")
            .to_owned();
        let client = self.client.clone();
        let file = path.clone();
        let packet = c.packet["id"].clone();
        let rx = background(move || {
            client.get::<Value>(
                "/api/panel/file-diff",
                &[("workspace", &root), ("path", &file), ("base", "main")],
            )
        });
        cx.spawn(async move |this, cx| {
            if let Ok(result) = rx.recv().await {
                let _ = this.update(cx, |s, cx| {
                    if let Some(c) = s
                        .candidates
                        .get_mut(index)
                        .filter(|c| c.packet["id"] == packet)
                    {
                        if c.patches.contains_key(&path) {
                            c.patches.insert(
                                path,
                                result
                                    .map(|v| {
                                        v["diff"]
                                            .as_str()
                                            .or(v["stagedDiff"].as_str())
                                            .unwrap_or("")
                                            .to_owned()
                                    })
                                    .unwrap_or_else(|e| e),
                            );
                        }
                    }
                    cx.notify()
                });
            }
        })
        .detach();
        cx.notify();
    }
    fn request_pick(&mut self, id: String, cx: &mut Context<Self>) {
        if !self.busy && !self.loading {
            self.confirmation = Some(id);
            cx.notify();
        }
    }
    fn pick(&mut self, id: String, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.confirmation = None;
        self.busy = true;
        self.error.clear();
        let client = self.client.clone();
        let rx = background(move || {
            client.pr_post("/api/orchestrator/comparison-pick", &json!({"packetId":id}))
        });
        cx.spawn(async move |this, cx| {
            if let Ok(result) = rx.recv().await {
                let _ = this.update(cx, |s, cx| {
                    s.busy = false;
                    match result {
                        Ok(v)
                            if v["ok"] == true
                                && (v["result"]["merged"] == true
                                    || v["result"]["reason"] == "quality_search_repair") =>
                        {
                            s.load(cx)
                        }
                        Ok(v) => {
                            s.error = v["error"]["message"]
                                .as_str()
                                .or(v["result"]["note"].as_str())
                                .unwrap_or("The selected candidate did not clear the merge gate.")
                                .into()
                        }
                        Err(e) => s.error = e,
                    }
                    cx.notify()
                });
            }
        })
        .detach();
        cx.notify();
    }
}
impl Render for Compare {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let quality = self.candidates.len() == 2
            && self
                .candidates
                .iter()
                .all(|c| c.packet["qualitySearch"]["version"] == 1);
        let pending = self.busy;
        let first = self
            .candidates
            .first()
            .and_then(|c| c.packet["id"].as_str())
            .unwrap_or("")
            .to_owned();
        div()
            .debug_selector(|| "panel-comparison".into())
            .size_full()
            .flex()
            .flex_col()
            .text_size(px(12.))
            .child(
                div()
                    .flex_shrink_0()
                    .p(px(12.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(theme().border)
                    .child(if quality {
                        "Quality search"
                    } else {
                        "Compare candidates"
                    })
                    .when(quality, |v| {
                        v.child(
                            div()
                                .id("comparison-quality-pick")
                                .focusable()
                                .cursor_pointer()
                                .on_click(
                                    cx.listener(move |s, _, _, cx| {
                                        s.request_pick(first.clone(), cx)
                                    }),
                                )
                                .child(if pending {
                                    "Verifying candidates…"
                                } else {
                                    "Verify, select & merge"
                                }),
                        )
                    }),
            )
            .when_some(self.confirmation.clone(), |v, id| {
                v.child(
                    div()
                        .p(px(12.))
                        .bg(theme().danger_surface)
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child("Merge the selected winner and archive the alternatives?")
                        .child(
                            div()
                                .flex()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .id("comparison-confirm")
                                        .debug_selector(|| "comparison-confirm".into())
                                        .focusable()
                                        .cursor_pointer()
                                        .p(px(8.))
                                        .rounded(px(7.))
                                        .bg(theme().danger)
                                        .text_color(theme().background)
                                        .hover(|v| v.opacity(0.85))
                                        .active(|v| v.opacity(0.7))
                                        .focus(|v| v.border_1().border_color(theme().text))
                                        .on_click(
                                            cx.listener(move |s, _, _, cx| s.pick(id.clone(), cx)),
                                        )
                                        .child("Merge winner and archive alternatives"),
                                )
                                .child(
                                    div()
                                        .id("comparison-cancel")
                                        .focusable()
                                        .cursor_pointer()
                                        .p(px(8.))
                                        .rounded(px(7.))
                                        .hover(|v| v.bg(theme().hover))
                                        .active(|v| v.bg(theme().selection))
                                        .on_click(cx.listener(|s, _, _, cx| {
                                            s.confirmation = None;
                                            cx.notify()
                                        }))
                                        .child("Cancel"),
                                ),
                        ),
                )
            })
            .when(!self.error.is_empty(), |v| {
                v.child(
                    div()
                        .p(px(12.))
                        .text_color(theme().danger)
                        .child(self.error.clone()),
                )
            })
            .when(self.candidates.is_empty(), |v| {
                v.child(
                    div()
                        .debug_selector(|| "comparison-empty".into())
                        .p(px(24.))
                        .child(if self.loading {
                            "Reading comparisons…"
                        } else {
                            "No comparisons yet. Run a best-of-N comparison to see candidates here."
                        }),
                )
            })
            .child(
                div()
                    .id("comparison-columns")
                    .track_scroll(&self.scroll)
                    .overflow_x_scroll()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .children(self.candidates.iter().enumerate().map(|(index, c)| {
                        let id = c.packet["id"].as_str().unwrap_or("").to_owned();
                        let preview = c
                            .preview
                            .as_ref()
                            .map(|p| {
                                if p["wouldMerge"] == true {
                                    "Passes gate".into()
                                } else {
                                    format!(
                                        "Blocked: {}",
                                        p["blockers"]
                                            .as_array()
                                            .unwrap_or(&vec![])
                                            .iter()
                                            .filter_map(|v| v.as_str())
                                            .collect::<Vec<_>>()
                                            .join(", ")
                                    )
                                }
                            })
                            .unwrap_or_else(|_| "Gate unavailable".into());
                        div()
                            .min_w(px(340.))
                            .w(px(440.))
                            .h_full()
                            .flex_shrink_0()
                            .flex()
                            .flex_col()
                            .border_r_1()
                            .border_color(theme().border)
                            .child(
                                div()
                                    .p(px(12.))
                                    .flex_shrink_0()
                                    .child(
                                        c.packet["id"].as_str().unwrap_or("Candidate").to_owned(),
                                    )
                                    .child(div().text_color(theme().text_muted).child(preview)),
                            )
                            .child(
                                div()
                                    .id(("comparison-files", index))
                                    .flex_1()
                                    .min_h_0()
                                    .overflow_y_scroll()
                                    .children(
                                        c.files["changedFiles"]
                                            .as_array()
                                            .into_iter()
                                            .flatten()
                                            .enumerate()
                                            .map(|(i, file)| {
                                                let path =
                                                    file["path"].as_str().unwrap_or("").to_owned();
                                                let label = path.clone();
                                                div()
                                                    .flex()
                                                    .flex_col()
                                                    .child(
                                                        div()
                                                            .id((
                                                                "comparison-file",
                                                                index * 10000 + i,
                                                            ))
                                                            .focusable()
                                                            .cursor_pointer()
                                                            .p(px(8.))
                                                            .child(label)
                                                            .on_click(cx.listener(
                                                                move |s, _, _, cx| {
                                                                    s.expand(
                                                                        index,
                                                                        path.clone(),
                                                                        cx,
                                                                    )
                                                                },
                                                            )),
                                                    )
                                                    .children(
                                                        c.patches
                                                            .get(
                                                                file["path"].as_str().unwrap_or(""),
                                                            )
                                                            .map(|patch| {
                                                                div()
                                                                    .p(px(8.))
                                                                    .font_family(theme().font_mono)
                                                                    .text_size(px(11.))
                                                                    .child(patch.clone())
                                                            }),
                                                    )
                                            }),
                                    ),
                            )
                            .when(!quality, |v| {
                                v.child(
                                    div()
                                        .id(("comparison-pick", index))
                                        .focusable()
                                        .p(px(10.))
                                        .cursor_pointer()
                                        .opacity(if pending { 0.5 } else { 1. })
                                        .on_click(cx.listener(move |s, _, _, cx| {
                                            s.request_pick(id.clone(), cx)
                                        }))
                                        .child(if pending {
                                            "Merging through gate…"
                                        } else {
                                            "Pick this winner"
                                        }),
                                )
                            })
                    })),
            )
    }
}
