use super::*;

fn check_bucket(check: &Value) -> &'static str {
    match string(check, "conclusion").to_lowercase().as_str() {
        "failure" | "timed_out" | "action_required" | "startup_failure" => "failing",
        "success" => "passed",
        "skipped" | "cancelled" => "skipped",
        "" => "running",
        _ => "neutral",
    }
}

impl PullRequests {
    pub(super) fn detail_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(number) = self.selected else {
            return div()
                .p(px(16.))
                .child("Select a pull request to read changes, checks and discussion.")
                .into_any_element();
        };
        let mut panel = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .gap(px(8.))
            .p(px(12.));
        panel = panel.child(
            div()
                .flex()
                .justify_between()
                .child(format!("PR #{number} · {}", string(&self.detail, "title")))
                .child(self.button(
                    "pr-detail-close",
                    "Back to list",
                    true,
                    |s, _, w, cx| {
                        s.selected = None;
                        s.detail_epoch += 1;
                        s.confirmation = None;
                        s.focus.focus(w);
                        s.changed(cx);
                    },
                    cx,
                )),
        );
        if self.detail_loading {
            panel = panel.child("Loading changes, checks and discussion…");
        }
        if !self.detail_error.is_empty() {
            panel = panel.child(
                div()
                    .text_color(theme().danger)
                    .child(self.detail_error.clone())
                    .child(self.button(
                        "pr-detail-retry",
                        "Retry",
                        !self.detail_loading,
                        move |s, _, _, cx| s.select(number, cx),
                        cx,
                    )),
            );
        }
        if self.detail.is_null() {
            return panel.into_any_element();
        }
        let mut actions = div().flex().flex_wrap().gap(px(5.));
        for (id, label) in [
            ("link", "Copy link"),
            ("number", "Copy PR number"),
            ("checkout", "Copy checkout command"),
            ("open", "Open on GitHub"),
        ] {
            actions = actions.child(self.button(
                &format!("pr-{id}"),
                label,
                true,
                move |s, _, _, cx| {
                    let url = string(&s.detail, "url");
                    if id == "open" {
                        if url.starts_with("https://") || url.starts_with("http://") {
                            cx.open_url(url);
                        }
                    } else {
                        let text = match id {
                            "link" => url.to_owned(),
                            "number" => number.to_string(),
                            _ => format!(
                                "gh pr checkout {number} --repo {}",
                                string(&s.page, "repo")
                            ),
                        };
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                    }
                },
                cx,
            ));
        }
        panel = panel.child(actions);
        let mut actions = div().flex().flex_wrap().gap(px(5.));
        let default_method = ["squash", "merge", "rebase"]
            .into_iter()
            .find(|m| {
                self.detail["allowedMergeMethods"].is_null()
                    || array(&self.detail, "allowedMergeMethods").contains(&json!(m))
            })
            .unwrap_or("");
        for (action, label) in [
            ("draft", "Convert to draft"),
            ("ready", "Ready for review"),
            ("enable-auto-merge", "Enable auto-merge"),
            ("disable-auto-merge", "Disable auto-merge"),
            ("close", "Close pull request"),
        ] {
            let show = match action {
                "draft" => self.detail["draft"] != true,
                "ready" => self.detail["draft"] == true,
                "enable-auto-merge" => self.detail["autoMergeEnabled"] != true,
                "disable-auto-merge" => self.detail["autoMergeEnabled"] == true,
                _ => true,
            };
            if show {
                actions = actions.child(self.button(
                    &format!("pr-{action}"),
                    label,
                    self.can(action, default_method, cx),
                    move |s, _, _, cx| s.prepare(action, default_method, cx),
                    cx,
                ));
            }
        }
        for method in ["squash", "merge", "rebase"] {
            actions = actions.child(self.button(
                &format!("pr-merge-{method}"),
                &format!("Merge ({method})"),
                self.can("merge", method, cx),
                move |s, _, _, cx| s.prepare("merge", method, cx),
                cx,
            ));
        }
        panel = panel.child(actions);
        if let Some(c) = &self.confirmation {
            panel = panel.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .bg(theme().selection)
                    .p(px(8.))
                    .child(format!(
                        "Confirm {} ({}) at {}",
                        c.action,
                        c.method,
                        c.head.chars().take(8).collect::<String>()
                    ))
                    .child(self.button(
                        "pr-confirm",
                        "Confirm",
                        c.head == string(&self.detail, "headSha")
                            && self.can(&c.action, &c.method, cx),
                        |s, _, _, cx| s.confirm(cx),
                        cx,
                    ))
                    .child(self.button(
                        "pr-cancel",
                        "Cancel",
                        true,
                        |s, _, _, cx| {
                            s.confirmation = None;
                            s.changed(cx);
                        },
                        cx,
                    )),
            );
        }
        let d = self.delivery(cx);
        if d.busy {
            panel = panel.child("Submitting…");
        }
        if !d.notice.is_empty() {
            panel = panel.child(
                div()
                    .text_color(if d.uncertain || d.partial_close {
                        theme().warning
                    } else {
                        theme().text_muted
                    })
                    .child(d.notice),
            );
        }
        if d.uncertain {
            let key = self.delivery_key(number);
            let attempt = d.attempt;
            panel = panel.child(self.button(
                "pr-acknowledge",
                "I've checked GitHub",
                true,
                move |s, _, _, cx| {
                    s.acknowledge(number, &key, attempt, cx);
                },
                cx,
            ));
        }
        if d.partial_close {
            panel = panel.child(self.button(
                "pr-retry-close",
                "Retry close",
                self.can("close", "", cx),
                |s, _, _, cx| s.prepare("close", "", cx),
                cx,
            ));
        }
        let mut tabs = div().flex().gap(px(6.));
        for tab in ["summary", "changes", "checks", "reviews"] {
            tabs = tabs.child(self.button(
                &format!("pr-tab-{tab}"),
                tab,
                true,
                move |s, _, _, cx| {
                    s.tab = tab.into();
                    s.changed(cx);
                },
                cx,
            ));
        }
        panel = panel.child(tabs);
        let mut content = div()
            .id("pr-detail-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(8.));
        if self.tab == "summary" {
            content = content
                .child(format!(
                    "{} · {} → {} · +{} −{} · {} files",
                    string(&self.detail, "author"),
                    string(&self.detail, "headRefName"),
                    string(&self.detail, "baseRefName"),
                    self.detail["additions"],
                    self.detail["deletions"],
                    self.detail["changedFiles"]
                ))
                .child(string(&self.detail, "body").to_owned())
                .child(format!(
                    "Review: {}",
                    string(&self.detail, "reviewDecision")
                ));
        }
        if self.tab == "changes" {
            let files = array(&self.detail, "files");
            if files.is_empty() {
                content = content.child("No file changes reported.");
            }
            for f in files {
                content = content.child(
                    div()
                        .child(format!(
                            "{} · {} +{} −{}",
                            string(&f, "path"),
                            string(&f, "status"),
                            f["additions"],
                            f["deletions"]
                        ))
                        .child(
                            div()
                                .font_family(theme().font_mono)
                                .text_size(px(11.))
                                .child(
                                    f["patch"]
                                        .as_str()
                                        .unwrap_or(
                                            "Patch unavailable. Open GitHub to inspect this file.",
                                        )
                                        .to_owned(),
                                ),
                        ),
                );
            }
        }
        if self.tab == "checks" {
            let checks = array(&self.detail, "statusCheckRollup");
            if checks.is_empty() {
                content = content.child("No checks reported for this PR.");
            }
            if self.detail["checksUnavailable"] == true {
                content = content.child("Some checks are unavailable. Refresh to try again.");
            }
            for (bucket, label) in [
                ("failing", "Failing"),
                ("running", "Running"),
                ("passed", "Passed"),
                ("neutral", "Neutral"),
                ("skipped", "Skipped"),
            ] {
                let items: Vec<_> = checks
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| check_bucket(c) == bucket)
                    .collect();
                if items.is_empty() {
                    continue;
                }
                let mut group = div()
                    .id(gpui::SharedString::from(format!("pr-check-group-{bucket}")))
                    .debug_selector(move || format!("pr-check-group-{bucket}"))
                    .flex()
                    .flex_col()
                    .flex_shrink_0()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(px(10.))
                            .text_color(theme().text_faint)
                            .child(format!("{label} · {}", items.len())),
                    );
                for (i, c) in items {
                    let url = string(c, "url").to_owned();
                    group = group.child(
                        div()
                            .id(("pr-check-row", i))
                            .debug_selector(move || format!("pr-check-row-{i}"))
                            .flex()
                            .flex_shrink_0()
                            .gap(px(8.))
                            .text_color(match bucket {
                                "failing" => theme().danger,
                                "passed" => theme().success,
                                "running" => theme().warning,
                                _ => theme().text_muted,
                            })
                            .child(format!(
                                "{} · {} · {}",
                                string(c, "name"),
                                string(c, "status"),
                                string(c, "conclusion")
                            ))
                            .child(self.button(
                                &format!("pr-check-{i}"),
                                "View run",
                                url.starts_with("https://") || url.starts_with("http://"),
                                move |_, _, _, cx| cx.open_url(&url),
                                cx,
                            )),
                    );
                }
                content = content.child(group);
            }
        }
        if self.tab == "reviews" {
            if self.detail["discussionIncomplete"] == true {
                content = content
                    .child("Discussion is incomplete. Open GitHub for the full conversation.");
            }
            let mut comments = array(&self.detail, "issueComments");
            comments.extend(array(&self.detail, "reviewComments"));
            if comments.is_empty() {
                content = content.child("No discussion reported.");
            }
            for c in comments {
                content = content.child(format!(
                    "{} {}\n{}",
                    string(&c, "user"),
                    string(&c, "path"),
                    string(&c, "body")
                ));
            }
        }
        if !self.governance_error.is_empty() {
            content = content.child(div().text_color(theme().danger).child(format!(
                "Merge preview unavailable: {}",
                self.governance_error
            )));
        }
        let merge_checks = array(&self.detail["mergeGate"], "checks");
        if let Some(check) = merge_checks.iter().find(|c| c["verdict"] == "fail") {
            content = content.child(
                div()
                    .text_color(theme().danger)
                    .child(format!("Merge refused: {}", string(check, "detail"))),
            );
        }
        if self.tab == "checks" {
            content = content.child("Merge gates (shared with desktop)");
            for check in merge_checks {
                content = content.child(format!(
                    "{} · {}\n{}\n{}",
                    string(&check, "name"),
                    string(&check, "verdict"),
                    string(&check, "detail"),
                    array(&check, "actions")
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                ));
            }
        }
        if let Some(packet) = &self.packet {
            content = content.child("Packet-linked merging and enabling auto-merge are unavailable in this build. Use the governed packet merge surface.");
            content = content.child(format!(
                "Packet {packet} · merge preview: {}",
                self.preview["wouldMerge"]
            ));
            for check in array(&self.preview, "checks") {
                content = content.child(format!(
                    "{} · {}\n{}\n{}",
                    string(&check, "name"),
                    string(&check, "verdict"),
                    string(&check, "detail"),
                    array(&check, "actions")
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                ));
            }
            content = content.child(format!("Blockers: {}", self.preview["blockers"]));
        }
        panel = panel.child(content);
        panel = panel.child(
            div()
                .h(px(60.))
                .bg(theme().surface_raised)
                .child(self.editor.clone()),
        );
        if self.review_head != string(&self.detail, "headSha") {
            panel = panel.child(self.button(
                "pr-review-head",
                "Use latest commit for review",
                !self.detail_loading,
                |s, _, _, cx| {
                    s.review_head = string(&s.detail, "headSha").into();
                    s.changed(cx);
                },
                cx,
            ));
        }
        let mut post = div().flex().flex_wrap().gap(px(5.));
        for (action, label) in [
            ("comment", "Post comment"),
            ("close-with-comment", "Close with comment"),
            ("approve", "Approve"),
            ("request-changes", "Request changes"),
            ("review-comment", "Submit review comment"),
        ] {
            post = post.child(self.button(
                &format!("pr-{action}"),
                label,
                self.can(action, "", cx),
                move |s, _, _, cx| s.prepare(action, "", cx),
                cx,
            ));
        }
        panel.child(post).into_any_element()
    }
}
