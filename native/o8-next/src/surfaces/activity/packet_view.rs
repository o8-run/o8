//! Expanded PacketCard. Lifecycle commands remain owned by ActivityPane.
use super::super::packet::{self, Command as Packet};
use super::*;

fn label(value: impl Into<SharedString>) -> gpui::Div {
    div()
        .text_size(px(10.))
        .font_weight(FontWeight(350.))
        .text_color(theme().text_faint)
        .child(value.into())
}
fn copy_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Array(values) => values
            .iter()
            .map(copy_value)
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => [
            "severity",
            "file",
            "label",
            "description",
            "summary",
            "message",
            "note",
        ]
        .iter()
        .filter_map(|key| value[*key].as_str())
        .collect::<Vec<_>>()
        .join(" · "),
        _ => value.to_string(),
    }
}
/// The directives route returns title/body, as the classic recall card consumes.
fn directive_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    let title = value["title"]
        .as_str()
        .or(value["text"].as_str())
        .unwrap_or("");
    let body = value["body"]
        .as_str()
        .or(value["content"].as_str())
        .unwrap_or("");
    [title, body]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
impl ActivityPane {
    pub(super) fn packet_button(
        &mut self,
        id: impl Into<String>,
        title: impl Into<SharedString>,
        action: Action,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        if self.pending {
            Self::inert(id, title)
        } else {
            self.button(id, title, action, cx)
        }
    }
    pub(super) fn packet_card(&mut self, row: &Row, cx: &mut Context<Self>) -> gpui::AnyElement {
        let p = &row.data;
        let read = self
            .packet
            .reads
            .get(&row.id)
            .filter(|r| r.identity == packet::identity(row))
            .cloned()
            .unwrap_or_default();
        let status = text(p, "status");
        let tab = self.packet.tabs.get(&row.id).copied().unwrap_or("agents");
        let header = div()
            .flex()
            .items_center()
            .gap(px(7.))
            .min_h(px(34.))
            .px(px(10.))
            .child(
                div()
                    .size(px(6.))
                    .rounded_full()
                    .bg(marks::packet_tone(&status).1),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .whitespace_normal()
                    .line_clamp(1)
                    .text_ellipsis()
                    .text_size(px(11.))
                    .font_weight(FontWeight(400.))
                    .child(format!(
                        "{} · {}",
                        text(p, "referenceLabel"),
                        text(p, "title")
                    )),
            )
            .child(label(marks::packet_tone(&status).0));
        let mut body = div()
            .w_full()
            .min_w(px(0.))
            .flex()
            .flex_col()
            .gap(px(9.))
            .px(px(10.))
            .pb(px(10.));
        // Field IDs are stable across display, editor and pending states.
        for (field, title, id) in [
            ("summary", "Summary", "activity-packet-summary"),
            ("runtime", "Runtime", "activity-packet-runtime"),
            ("workspaceTargetPath", "Repo", "activity-packet-repo"),
            ("branchTarget", "Branch", "activity-packet-branch"),
        ] {
            let mut line = div()
                .id(id)
                .debug_selector(move || id.to_string())
                .flex()
                .flex_col()
                .gap(px(4.));
            let editing = self
                .packet
                .editor
                .as_ref()
                .filter(|e| e.id == row.id && e.field == field)
                .map(|e| e.input.clone());
            let value = text(p, field);
            let display = if field == "workspaceTargetPath" && !value.is_empty() {
                self.repos
                    .iter()
                    .find(|repo| repo.local_path == value)
                    .map(|repo| repo.name.clone())
                    .unwrap_or_else(|| value.rsplit('/').next().unwrap_or(&value).to_string())
            } else if value.is_empty() {
                format!("Choose {}", title.to_lowercase())
            } else {
                value.clone()
            };
            let action = Packet::Edit(row.clone(), field);
            let enabled =
                field == "summary" || (field == "branchTarget" && p["queueState"] == "draft");
            let heading = div()
                .flex()
                .items_start()
                .gap(px(9.))
                .child(div().w(px(48.)).flex_shrink_0().child(label(title)));
            if let Some(input) = editing {
                line = line
                    .child(heading)
                    .child(div().w_full().child(input))
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .child(self.packet_button(
                                "activity-packet-save",
                                "Save",
                                Action::Packet(Packet::Save(row.clone())),
                                cx,
                            ))
                            .child(self.packet_button(
                                "activity-packet-cancel",
                                "Cancel",
                                Action::Packet(Packet::Cancel),
                                cx,
                            )),
                    );
            } else {
                let value_id = format!("{id}-value");
                let active = enabled && !self.pending;
                let selected = self.keyboard.as_deref() == Some(value_id.as_str());
                let control = if active {
                    self.control(value_id.clone(), Action::Packet(action), cx)
                } else {
                    div()
                        .id(SharedString::from(value_id.clone()))
                        .debug_selector(move || value_id.clone())
                };
                let content = div()
                    .w_full()
                    .min_w(px(0.))
                    .whitespace_normal()
                    .line_clamp(if field == "summary" { 3 } else { 1 })
                    .when(field == "summary", |v| {
                        v.line_height(px(17.)).max_h(px(51.))
                    })
                    .text_ellipsis()
                    .child(display);
                line = line.child(
                    heading.child(
                        control
                            .flex_1()
                            .min_w(px(0.))
                            .flex()
                            .flex_col()
                            .min_h(px(18.))
                            .rounded(px(4.))
                            .text_size(px(11.5))
                            .font_weight(FontWeight(350.))
                            .text_color(theme().text_secondary)
                            .bg(if selected { theme().selection } else { CLEAR })
                            .when(active, |v| v.hover(|v| v.bg(theme().hover)))
                            .child(content),
                    ),
                );
            }
            body = body.child(line);
        }
        let routing = [
            text(p, "assignedModel"),
            text(&p["workerRouting"], "selectedEffort"),
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        if !routing.is_empty() {
            body = body.child(label(routing));
        }
        let blocker = p["recovery"]["message"]
            .as_str()
            .or(p["blockedReason"].as_str())
            .unwrap_or("");
        if !blocker.is_empty() {
            body = body.child(
                div()
                    .text_color(theme().text_secondary)
                    .child(blocker.to_owned()),
            );
        }
        let mut tabs = div()
            .flex()
            .gap(px(4.))
            .border_b_1()
            .border_color(theme().border)
            .pb(px(5.));
        for (key, title) in [
            ("agents", "Agents"),
            ("context", "Context"),
            ("changes", "Changes"),
            ("files", "Files"),
        ] {
            tabs = tabs.child(
                self.button(
                    format!("activity-packet-tab-{key}"),
                    title,
                    Action::Packet(Packet::Tab(row.id.clone(), key)),
                    cx,
                )
                .border_0()
                .rounded(px(6.))
                .when(tab == key, |v| {
                    v.bg(theme().selection).text_color(theme().text)
                }),
            );
        }
        body = body.child(tabs);
        let content = match tab {
            "context" => self.packet_context(row, &read, cx),
            "changes" => self.packet_changes(row, &read, cx),
            "files" => self.packet_files(row, &read, cx),
            _ => self.packet_agents(row),
        };
        body = body.child(content);
        if read.loading {
            body = body.child(
                label("Loading packet details…")
                    .debug_selector(|| "activity-packet-loading".to_string()),
            );
        }
        if let Some(error) = &read.error {
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(5.))
                    .child(
                        label(error.clone())
                            .debug_selector(|| "activity-packet-read-error".to_string()),
                    )
                    .child(self.button(
                        "activity-packet-retry-read",
                        "Retry packet details",
                        Action::Packet(Packet::Read(row.clone())),
                        cx,
                    )),
            );
        }
        if status == "awaiting_review" || !p["review"].is_null() {
            body = body.child(self.packet_review(row, &read, cx));
        }
        let details = self.packet.briefs.contains(&row.id);
        let actions = self
            .packet_button(
                "activity-packet-details",
                if details { "Hide details" } else { "Details" },
                Action::Packet(Packet::Brief(row.id.clone())),
                cx,
            )
            .into_any_element();
        if details {
            let brief = [
                text(p, "title"),
                text(p, "summary"),
                text(p, "description"),
                text(p, "body"),
                format!(
                    "Packet {}\nRuntime: {}\nBranch: {}",
                    row.id,
                    text(p, "runtime"),
                    text(p, "branchTarget")
                ),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
            body = body.child(div().text_size(px(11.)).child(brief));
        }
        body = body.child(self.packet_controls(row, actions, cx));
        if self.packet.action.as_deref() == Some(&row.id) && !self.notice.is_empty() {
            body = body.child(
                label(self.notice.clone())
                    .text_color(if self.notice_error {
                        theme().danger
                    } else {
                        theme().text_secondary
                    })
                    .debug_selector(|| "activity-packet-feedback".to_string()),
            );
        }
        div()
            .id("activity-packet-card")
            .debug_selector(|| "activity-packet-card".to_string())
            .w_full()
            .min_w(px(0.))
            .whitespace_normal()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .rounded(px(14.))
            .border_1()
            .border_color(theme().border)
            .bg(theme().surface)
            .overflow_hidden()
            .text_size(px(11.5))
            .text_color(theme().text_secondary)
            .child(header)
            .child(body)
            .into_any_element()
    }
    fn packet_agents(&self, row: &Row) -> gpui::AnyElement {
        let p = &row.data;
        let lane = &p["lane"];
        let mut view = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .debug_selector(|| "activity-packet-agents".to_string());
        for (title, value) in [
            ("Worker", text(lane, "laneId")),
            ("Execution", text(lane, "status")),
            ("Runtime", text(p, "runtime")),
            ("Model", text(p, "assignedModel")),
            (
                "Last event",
                marks::age(&text(lane, "lastEventAt"), crate::clock::now()),
            ),
        ] {
            if !value.is_empty() {
                view = view.child(
                    label(format!("{title} · {value}")).when(title == "Last event", |v| {
                        v.debug_selector(|| "activity-packet-last-event".into())
                    }),
                );
            }
        }
        let attempts = p["attemptCount"].as_u64().unwrap_or(0);
        view.child(label(format!(
            "{attempts} execution attempt{}",
            if attempts == 1 { "" } else { "s" }
        )))
        .when(lane.is_null(), |v| {
            v.child(label("No worker assigned yet."))
        })
        .into_any_element()
    }
    fn packet_context(
        &mut self,
        _row: &Row,
        read: &packet::Review,
        _cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let mut view = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(if read.spec.is_empty() {
                "No additional packet context supplied.".to_string()
            } else {
                read.spec.clone()
            });
        for directive in read.directives["directives"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let value = directive_text(directive);
            if !value.is_empty() {
                view = view.child(label(format!("Directive · {value}")));
            }
        }
        view.into_any_element()
    }
    fn packet_changes(
        &mut self,
        row: &Row,
        read: &packet::Review,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let mut view = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(label("Branch changes against the refreshed base."));
        if !read.diff.is_null() {
            view = view
                .child(label(format!(
                    "Base {} · HEAD {}",
                    text(&read.diff, "base"),
                    text(&read.diff, "headSha")
                )))
                .child(text(&read.diff, "stat"));
            if read.diff["truncated"] == true {
                view = view.child(label(
                    "Diff is truncated. Review the complete files before merging.",
                ));
            }
        }
        if !text(&row.data["lane"], "laneId").is_empty() {
            view = view.child(self.button(
                "activity-packet-open-diff",
                "Open branch diff",
                Action::Packet(Packet::Diff(row.clone())),
                cx,
            ));
        } else {
            view = view.child(label("A worker lane is required to review a branch diff."));
        }
        view.into_any_element()
    }
    fn packet_files(
        &mut self,
        row: &Row,
        read: &packet::Review,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let allowed = row.data["allowedFiles"]
            .as_array()
            .filter(|v| !v.is_empty());
        let predicted = row.data["predictedFiles"].as_array();
        let (title, files) = if let Some(paths) = allowed {
            ("Allowed files", paths.clone())
        } else if !read.files.is_empty() {
            ("Changed files", read.files.clone())
        } else {
            ("Predicted files", predicted.cloned().unwrap_or_default())
        };
        let all = self.packet.all_files.contains(&row.id);
        let mut view = div()
            .flex()
            .flex_col()
            .gap(px(5.))
            .child(label(format!("{title} · {}", files.len())));
        for (i, file) in files
            .iter()
            .take(if all { usize::MAX } else { 5 })
            .enumerate()
        {
            let path = file
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| text(file, "path"));
            view = view.child(
                div()
                    .id(SharedString::from(format!("activity-packet-file-{i}")))
                    .debug_selector(move || format!("activity-packet-file-{i}"))
                    .text_size(px(11.))
                    .child(format!(
                        "{}  {}",
                        path,
                        if file.is_object() {
                            format!(
                                "+{} −{}",
                                file["additions"].as_u64().unwrap_or(0),
                                file["deletions"].as_u64().unwrap_or(0)
                            )
                        } else {
                            String::new()
                        }
                    )),
            );
        }
        if files.is_empty() {
            view = view.child(label("No files to show yet."));
        }
        if files.len() > 5 {
            view = view.child(self.button(
                "activity-packet-show-files",
                if all {
                    "Show fewer files"
                } else {
                    "Show all files"
                },
                Action::Packet(Packet::More(row.id.clone())),
                cx,
            ));
        }
        view.into_any_element()
    }
}
#[path = "packet_review.rs"]
mod review;
