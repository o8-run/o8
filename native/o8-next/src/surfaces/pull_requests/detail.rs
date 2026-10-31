//! The pull request detail, as desktop PrPanel draws it: header with the
//! Check out, Merge and ··· menus, title, branches, the tab strip with the
//! checks summary, the tab body, and the Comment and Review composer.
use super::controls::{icon, menu_row};
use super::*;

pub(super) const EXTERNAL: &str =
    "M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6";
const CHEVRON: &str = "m6 9 6 6 6-6";
const ARROW_UP: &str = "m5 12 7-7 7 7 M12 19V5";
const MESSAGE: &str = "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z";
pub(super) const CHECK_CIRCLE: &str = "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z M9 12l2 2 4-4";
pub(super) const X_CIRCLE: &str = "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z M15 9l-6 6 M9 9l6 6";
pub(super) const CLOCK: &str = "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z M12 6v6l4 2";

pub(super) fn check_bucket(check: &Value) -> &'static str {
    match string(check, "conclusion").to_lowercase().as_str() {
        "failure" | "timed_out" | "action_required" | "startup_failure" => "failing",
        "success" => "passed",
        "skipped" | "cancelled" => "skipped",
        "" => "running",
        _ => "neutral",
    }
}

/// summarizeChecks: the tone and the line beside the tab strip.
fn check_summary(checks: &[Value]) -> (&'static str, usize, String) {
    let count = |bucket| checks.iter().filter(|c| check_bucket(c) == bucket).count();
    let (passed, failing, running, total) =
        (count("passed"), count("failing"), count("running"), checks.len());
    if failing > 0 {
        ("failure", failing, format!("{failing} failing · {passed} of {total} passing"))
    } else if running > 0 {
        ("pending", 0, format!("{running} pending · {passed} of {total} passing"))
    } else if total > 0 {
        ("success", 0, format!("{passed} of {total} passing"))
    } else {
        ("unknown", 0, "No checks reported".into())
    }
}

/// prActionButton: 30px, bordered, on the hover fill.
fn action_button(id: String, primary: bool, enabled: bool) -> gpui::Stateful<gpui::Div> {
    let selector = id.clone();
    div()
        .id(gpui::SharedString::from(id))
        .debug_selector(move || selector.clone())
        .h(px(30.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .px(px(10.))
        .rounded(px(8.))
        .border_1()
        .border_color(if primary { theme().accent } else { theme().border })
        .bg(if primary { theme().accent } else { theme().hover })
        .text_size(px(11.))
        .text_color(if primary { gpui::white().into() } else { theme().text })
        .opacity(if enabled { 1. } else { 0.45 })
        .when(enabled, |b| b.cursor_pointer())
}

/// One PrActionMenu entry: (selector, label, enabled, danger, action).
type Item = (String, String, bool, bool, Rc<dyn Fn(&mut PullRequests, &mut Context<PullRequests>)>);

fn item(
    id: &str,
    label: &str,
    enabled: bool,
    run: impl Fn(&mut PullRequests, &mut Context<PullRequests>) + 'static,
) -> Option<Item> {
    let run: Rc<dyn Fn(&mut PullRequests, &mut Context<PullRequests>)> = Rc::new(run);
    Some((format!("pr-{id}"), label.to_owned(), enabled, false, run))
}

impl PullRequests {
    fn close_menu(&mut self, cx: &mut Context<Self>) {
        self.menu = None;
        self.changed(cx);
    }

    /// A PrActionMenu: its trigger, and while open its items under it, right-aligned.
    fn action_menu(
        &self,
        id: &'static str,
        trigger: gpui::Stateful<gpui::Div>,
        enabled: bool,
        items: Vec<Option<Item>>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let open = self.menu == Some(id);
        let trigger = trigger.on_click(cx.listener(move |s, _, _, cx| {
            if enabled {
                s.menu = (s.menu != Some(id)).then_some(id);
                s.changed(cx);
            }
        }));
        let menu = open.then(|| {
            let rows = items.into_iter().map(|entry| match entry {
                None => div()
                    .h(px(1.))
                    .mx(px(6.))
                    .my(px(5.))
                    .bg(theme().border)
                    .into_any_element(),
                Some((selector, label, enabled, danger, run)) => menu_row(selector, false)
                    .min_h(px(32.))
                    .py(px(6.))
                    .rounded(px(6.))
                    .text_size(px(12.))
                    .when(danger, |row| row.text_color(theme().danger))
                    .opacity(if enabled { 1. } else { 0.45 })
                    .child(label)
                    .on_click(cx.listener(move |s, _, _, cx| {
                        if enabled {
                            s.menu = None;
                            run(s, cx);
                            s.changed(cx);
                        }
                    }))
                    .into_any_element(),
            });
            div()
                .absolute()
                .right_0()
                .top(px(37.))
                .child(
                    gpui::deferred(
                        gpui::anchored().position(gpui::point(px(0.), px(0.))).child(
                            div()
                                .id("pr-action-backdrop")
                                .w(px(100_000.))
                                .h(px(100_000.))
                                .on_mouse_down(
                                    gpui::MouseButton::Left,
                                    cx.listener(|s, _, _, cx| s.close_menu(cx)),
                                ),
                        ),
                    )
                    .with_priority(1),
                )
                .child(
                    gpui::deferred(
                        gpui::anchored()
                            .anchor(gpui::Corner::TopRight)
                            .snap_to_window_with_margin(px(12.))
                            .child(
                                div()
                                    .id(gpui::SharedString::from(format!("pr-{id}-items")))
                                    .debug_selector(move || format!("pr-{id}-items"))
                                    .occlude()
                                    .w(px(236.))
                                    .p(px(5.))
                                    .rounded(px(12.))
                                    .bg(crate::theme::popover_background())
                                    .border_1()
                                    .border_color(theme().border)
                                    .shadow_lg()
                                    .flex()
                                    .flex_col()
                                    .children(rows),
                            ),
                    )
                    .with_priority(2),
                )
        });
        div()
            .relative()
            .flex_shrink_0()
            .child(trigger)
            .children(menu)
            .into_any_element()
    }

    fn copy(&mut self, text: String, notice: &str, cx: &mut Context<Self>) {
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
        self.notice = notice.to_owned();
    }

    /// PrPanelActions: Check out, Merge (or Ready for review), and ···.
    fn actions(&self, number: u64, cx: &mut Context<Self>) -> AnyElement {
        let d = &self.detail;
        let open = string(d, "state").eq_ignore_ascii_case("open") && d["mergedAt"].is_null();
        let draft = d["draft"] == true;
        let repo = string(&self.page, "repo").to_owned();
        let methods = [("merge", "Merge"), ("squash", "Squash and merge"), ("rebase", "Rebase and merge")];
        let merge_items = |cx: &gpui::App| {
            methods
                .iter()
                .map(|(method, label)| {
                    let method = *method;
                    item(&format!("merge-{method}"), label, self.can("merge", method, cx), move |s, cx| {
                        s.prepare("merge", method, cx)
                    })
                })
                .collect::<Vec<_>>()
        };
        let default_method = ["squash", "merge", "rebase"]
            .into_iter()
            .find(|m| d["allowedMergeMethods"].is_null() || array(d, "allowedMergeMethods").contains(&json!(m)))
            .unwrap_or("");
        let auto = d["autoMergeEnabled"] == true;
        let (auto_action, auto_label) = if auto {
            ("disable-auto-merge", "Disable auto-merge")
        } else {
            ("enable-auto-merge", "Enable auto-merge")
        };
        let (draft_action, draft_label) = if draft {
            ("ready", "Ready for review")
        } else {
            ("draft", "Convert to draft")
        };
        let url = string(d, "url").to_owned();
        let link = url.clone();
        let mut more: Vec<Option<Item>> = vec![
            item("write-comment", "Write a comment", true, |s, cx| s.set_composer("comment", cx)),
            item("write-review", "Submit a review", true, |s, cx| s.set_composer("review", cx)),
            None,
        ];
        if open {
            more.push(item(draft_action, draft_label, self.can(draft_action, "", cx), move |s, cx| {
                s.prepare(draft_action, "", cx)
            }));
            more.push(item(
                auto_action,
                auto_label,
                self.can(auto_action, default_method, cx),
                move |s, cx| s.prepare(auto_action, default_method, cx),
            ));
            more.extend(merge_items(cx));
        }
        more.extend([
            None,
            item("detail-refresh", "Refresh", true, move |s, cx| s.select(number, cx)),
            item("open", "Open on GitHub", url.starts_with("https://"), move |_, cx| cx.open_url(&url)),
            item("link", "Copy link", true, move |s, cx| s.copy(link.clone(), "Pull request link copied.", cx)),
            item("number", "Copy PR number", true, move |s, cx| {
                s.copy(number.to_string(), "Pull request number copied.", cx)
            }),
        ]);
        if open {
            more.push(None);
            more.push(
                item("close", "Close pull request", self.can("close", "", cx), |s, cx| {
                    s.prepare("close", "", cx)
                })
                .map(|mut close| {
                    close.3 = true;
                    close
                }),
            );
        }
        let busy = self.delivery(cx).busy;
        let checkout = self.action_menu(
            "checkout-menu",
            action_button("pr-checkout-menu".into(), false, !busy)
                .child(icon(super::ICON_PR, 12.))
                .child("Check out")
                .child(icon(CHEVRON, 11.)),
            !busy,
            vec![item("checkout", "Copy checkout command", !repo.is_empty(), move |s, cx| {
                s.copy(format!("gh pr checkout {number} --repo {repo}"), "Checkout command copied.", cx)
            })],
            cx,
        );
        let primary = open.then(|| {
            if draft {
                action_button("pr-ready-button".into(), false, self.can("ready", "", cx))
                    .text_color(theme().accent)
                    .child("Ready for review")
                    .on_click(cx.listener(|s, _, _, cx| s.prepare("ready", "", cx)))
                    .into_any_element()
            } else {
                let items = merge_items(cx);
                let enabled = items.iter().flatten().any(|(_, _, enabled, _, _)| *enabled);
                self.action_menu(
                    "merge",
                    action_button("pr-merge".into(), true, enabled)
                        .child(icon(super::ICON_PR, 12.))
                        .child("Merge")
                        .child(icon(CHEVRON, 11.)),
                    enabled,
                    items,
                    cx,
                )
            }
        });
        let dots = self.action_menu(
            "actions",
            action_button("pr-actions".into(), false, !busy)
                .text_size(px(16.))
                .child("···"),
            !busy,
            more,
            cx,
        );
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(8.))
            .ml_auto()
            .child(checkout)
            .children(primary)
            .child(dots)
            .into_any_element()
    }

    pub(crate) fn set_composer(&mut self, mode: &'static str, cx: &mut Context<Self>) {
        self.composer = mode;
        let placeholder = match (mode, self.review_action) {
            ("review", "approve") => "Review feedback (optional)",
            ("review", _) => "Leave review feedback",
            _ => "Leave a comment",
        };
        self.editor.update(cx, |e, cx| {
            e.placeholder = placeholder.into();
            cx.notify();
        });
        self.changed(cx);
    }

    /// PrActionConfirm, the delivery notices, and the merge gate refusal.
    fn confirmation_and_notices(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out = vec![];
        let d = &self.detail;
        if let Some(c) = &self.confirmation {
            let changed = c.head != string(d, "headSha");
            let ok = !changed && self.can(&c.action, &c.method, cx);
            let title = match c.action.as_str() {
                "merge" => format!("{} · #{}", match c.method.as_str() {
                    "squash" => "Squash and merge",
                    "rebase" => "Rebase and merge",
                    _ => "Merge",
                }, c.number),
                "close" => format!("Close pull request · #{}", c.number),
                "draft" => format!("Convert to draft · #{}", c.number),
                "ready" => format!("Ready for review · #{}", c.number),
                "enable-auto-merge" => format!("Enable auto-merge · #{}", c.number),
                "disable-auto-merge" => format!("Disable auto-merge · #{}", c.number),
                other => format!("{other} · #{}", c.number),
            };
            let body = match c.action.as_str() {
                "enable-auto-merge" => "GitHub will merge when its rules are satisfied. It may merge immediately if ready.".to_owned(),
                "merge" => format!("Merge into {} using {}. GitHub checks repository rules before merging.", string(d, "baseRefName"), c.method),
                "close" => "Close this pull request on GitHub. Its branch is kept.".to_owned(),
                _ => "Update this pull request on GitHub.".to_owned(),
            };
            out.push(
                div()
                    .debug_selector(|| "pr-confirmation".into())
                    .w_full()
                    .p(px(12.))
                    .rounded(px(12.))
                    .border_1()
                    .border_color(theme().border)
                    .bg(crate::theme::popover_background())
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .text_size(px(11.))
                    .child(div().text_size(px(13.)).text_color(theme().text).child(title))
                    .child(if changed || !ok {
                        div()
                            .text_color(theme().danger)
                            .child("The pull request changed. Cancel and review the latest commit and merge gates.")
                    } else {
                        div()
                            .text_color(theme().text_secondary)
                            .child(body)
                            .child(div().mt(px(6.)).child(format!(
                                "Commit {}",
                                c.head.chars().take(8).collect::<String>()
                            )))
                    })
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(8.))
                            .child(
                                action_button("pr-cancel".into(), false, true)
                                    .child("Cancel")
                                    .on_click(cx.listener(|s, _, _, cx| {
                                        s.confirmation = None;
                                        s.changed(cx);
                                    })),
                            )
                            .child(
                                action_button("pr-confirm".into(), true, ok)
                                    .child(if c.action == "merge" { "Merge" } else { "Confirm" })
                                    .on_click(cx.listener(move |s, _, _, cx| {
                                        if ok {
                                            s.confirm(cx)
                                        }
                                    })),
                            ),
                    )
                    .into_any_element(),
            );
        }
        let delivery = self.delivery(cx);
        let line = |text: String, color| div().w_full().text_size(px(11.)).text_color(color).child(text);
        if delivery.busy {
            out.push(line("Submitting…".into(), theme().text_muted).into_any_element());
        }
        if !self.notice.is_empty() {
            out.push(line(self.notice.clone(), theme().text_muted).into_any_element());
        }
        if !delivery.notice.is_empty() {
            let warn = delivery.uncertain || delivery.partial_close;
            out.push(
                line(delivery.notice.clone(), if warn { theme().warning } else { theme().text_muted })
                    .into_any_element(),
            );
        }
        if let Some(number) = self.selected {
            if delivery.uncertain {
                let key = self.delivery_key(number);
                let attempt = delivery.attempt;
                out.push(
                    action_button("pr-acknowledge".into(), false, true)
                        .child("I've checked GitHub")
                        .on_click(cx.listener(move |s, _, _, cx| s.acknowledge(number, &key, attempt, cx)))
                        .into_any_element(),
                );
            }
            if delivery.partial_close {
                let enabled = self.can("close", "", cx);
                out.push(
                    action_button("pr-retry-close".into(), false, enabled)
                        .child("Retry close")
                        .on_click(cx.listener(|s, _, _, cx| s.prepare("close", "", cx)))
                        .into_any_element(),
                );
            }
        }
        if let Some(check) = array(&d["mergeGate"], "checks").iter().find(|c| c["verdict"] == "fail") {
            out.push(line(format!("Merge refused: {}", string(check, "detail")), theme().danger).into_any_element());
        }
        if !self.governance_error.is_empty() {
            out.push(
                line(format!("Merge preview unavailable: {}", self.governance_error), theme().danger)
                    .into_any_element(),
            );
        }
        out
    }

    /// PrPanelHeader: repository and number, state, actions, title, branches.
    fn header(&self, number: u64, cx: &mut Context<Self>) -> AnyElement {
        let d = &self.detail;
        let state = if !d["mergedAt"].is_null() {
            "Merged"
        } else if string(d, "state").eq_ignore_ascii_case("closed") {
            "Closed"
        } else if d["draft"] == true {
            "Draft"
        } else {
            "Open"
        };
        let tone = match state {
            "Open" => theme().success,
            "Closed" => theme().danger,
            "Draft" => theme().text_muted,
            _ => theme().accent,
        };
        let repo = match string(d, "resolvedRepo") {
            "" => string(&self.page, "repo"),
            repo => repo,
        };
        let url = string(d, "url").to_owned();
        let updated = crate::clock::timestamp(string(d, "updatedAt"));
        let note = |text: String| div().text_size(px(11.)).text_color(theme().text_muted).child(text);
        let mut watch = vec![];
        if d["checksUnavailable"] == true || d["discussionIncomplete"] == true {
            watch.push(note(format!(
                "{}{}",
                if d["checksUnavailable"] == true { "Checks unavailable. " } else { "" },
                if d["discussionIncomplete"] == true {
                    "Some discussion is available only on GitHub."
                } else {
                    ""
                }
            )));
        }
        div()
            .flex_shrink_0()
            .pt(px(14.))
            .px(px(18.))
            .pb(px(16.))
            .border_b_1()
            .border_color(theme().border)
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(12.))
                    .min_h(px(30.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .min_w_0()
                            .child(
                                div()
                                    .id("pr-github-link")
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .min_w_0()
                                    .text_size(px(12.))
                                    .text_color(theme().text_muted)
                                    .cursor_pointer()
                                    .child(div().min_w_0().truncate().child(repo.to_owned()))
                                    .child(div().text_color(tone).child(format!("#{number}")))
                                    .child(crate::icon::stroke(EXTERNAL, theme().text_muted, 12., 1.8))
                                    .on_click(move |_, _, cx| {
                                        if url.starts_with("https://") {
                                            cx.open_url(&url)
                                        }
                                    }),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(5.))
                                    .text_size(px(10.))
                                    .text_color(tone)
                                    .child(crate::icon::stroke(super::ICON_PR, tone, 12., 1.8))
                                    .child(state),
                            ),
                    )
                    .child(self.actions(number, cx))
                    .children(self.confirmation_and_notices(cx)),
            )
            // PrPanelTitle.
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(15.))
                            .line_height(gpui::relative(1.4))
                            .child(string(d, "title").to_owned()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .text_size(px(12.))
                            .text_color(theme().text_secondary)
                            .child(crate::icon::stroke(super::controls::USER, theme().text_secondary, 20., 1.6))
                            .child(string(d, "author").to_owned())
                            .when(updated.is_some(), |line| {
                                line.child("·").child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(theme().text_muted)
                                        .child(format!("updated {}", crate::clock::age(updated, crate::clock::now()))),
                                )
                            }),
                    ),
            )
            .children(watch)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(10.))
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .min_w_0()
                            .font_family(theme().font_mono)
                            .child(div().text_color(theme().text_secondary).child(string(d, "baseRefName").to_owned()))
                            .child("←")
                            .child(div().min_w_0().truncate().child(string(d, "headRefName").to_owned())),
                    )
                    .when(self.tab != "changes", |row| {
                        let files = d["changedFiles"].as_u64().unwrap_or(0);
                        row.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(format!("{files} file{}", if files == 1 { "" } else { "s" }))
                                .child(div().text_color(theme().success).child(format!("+{}", d["additions"].as_u64().unwrap_or(0))))
                                .child(div().text_color(theme().danger).child(format!("−{}", d["deletions"].as_u64().unwrap_or(0)))),
                        )
                    }),
            )
            .into_any_element()
    }

    /// PrPanelTabs: the segmented tab strip and the checks summary beside it.
    fn tabs(&self, cx: &mut Context<Self>) -> AnyElement {
        let d = &self.detail;
        let checks = array(d, "statusCheckRollup");
        let (tone, failing, label) = check_summary(&checks);
        let reviews = array(d, "reviewComments").len() + array(d, "issueComments").len();
        let files = d["changedFiles"].as_u64().unwrap_or(array(d, "files").len() as u64) as usize;
        let tabs = [
            ("summary", "Summary", 0),
            ("timeline", "Timeline", 0),
            ("changes", "Changes", files),
            ("checks", "Checks", failing),
            ("reviews", "Reviews", reviews),
        ];
        let strip = tabs.into_iter().map(|(tab, text, count)| {
            let active = self.tab == tab;
            let failing_checks = tab == "checks" && failing > 0;
            div()
                .id(gpui::SharedString::from(format!("pr-tab-{tab}")))
                .debug_selector(move || format!("pr-tab-{tab}"))
                .min_h(px(30.))
                .px(px(10.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(14.))
                .text_size(px(12.))
                .cursor_pointer()
                .when(active, |t| t.bg(theme().surface_raised))
                .text_color(if failing_checks {
                    theme().danger
                } else if active {
                    theme().text
                } else {
                    theme().text_muted
                })
                .when(failing_checks, |t| t.child(crate::icon::stroke(X_CIRCLE, theme().danger, 13., 1.8)))
                .child(text)
                .when(count > 0, |t| t.child(div().text_size(px(10.)).opacity(0.8).child(count.to_string())))
                .on_click(cx.listener(move |s, _, _, cx| s.show_tab(tab, cx)))
        });
        let (glyph, color) = match tone {
            "failure" => (X_CIRCLE, theme().danger),
            "pending" => (CLOCK, theme().text_muted),
            "success" => (CHECK_CIRCLE, theme().success),
            _ => (CHECK_CIRCLE, theme().text_muted),
        };
        div()
            .flex_shrink_0()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .py(px(10.))
            .px(px(18.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(3.))
                    .p(px(4.))
                    .rounded(px(18.))
                    .border_1()
                    .border_color(theme().border)
                    .bg(theme().hover)
                    .children(strip),
            )
            .child(
                div()
                    .id("pr-checks-summary")
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(11.))
                    .text_color(color)
                    .cursor_pointer()
                    .when(!checks.is_empty(), |s| s.child(crate::icon::stroke(glyph, color, 13., 1.8)))
                    .child(label)
                    .on_click(cx.listener(|s, _, _, cx| s.show_tab("checks", cx))),
            )
            .into_any_element()
    }

    fn show_tab(&mut self, tab: &'static str, cx: &mut Context<Self>) {
        self.tab = tab.into();
        if tab == "timeline" && self.timeline.is_empty() && !self.timeline_loading {
            self.load_timeline(false, cx);
        }
        self.changed(cx);
    }

    fn mode_button(
        &self,
        id: &'static str,
        text: &'static str,
        glyph: &'static str,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let on = self.composer == id;
        let color = if on { theme().text } else { theme().text_muted };
        div()
            .id(gpui::SharedString::from(format!("pr-composer-{id}")))
            .debug_selector(move || format!("pr-composer-{id}"))
            .min_h(px(26.))
            .px(px(8.))
            .flex()
            .items_center()
            .gap(px(5.))
            .rounded(px(7.))
            .text_size(px(11.))
            .cursor_pointer()
            .text_color(color)
            .when(on, |m| m.bg(theme().hover))
            .child(crate::icon::stroke(glyph, color, 13., 1.8))
            .child(text)
            .on_click(cx.listener(move |s, _, _, cx| s.set_composer(id, cx)))
    }

    /// PrCommentComposer: Comment or Review, the notice, review choices, the
    /// draft, and Close with comment / Post comment or Submit review.
    fn composer(&self, cx: &mut Context<Self>) -> AnyElement {
        let d = &self.detail;
        let number = self.selected.unwrap_or_default();
        let review = self.composer == "review";
        let notice = |text: String| {
            div()
                .flex_shrink_0()
                .px(px(14.))
                .pt(px(8.))
                .text_size(px(10.))
                .text_color(theme().text_muted)
                .child(text)
        };
        let repo = string(&self.page, "repo").to_owned();
        let head = string(d, "headSha").to_owned();
        let current = !self.review_head.is_empty() && self.review_head == head;
        let choices = [
            ("review-comment", "Comment"),
            ("approve", "Approve"),
            ("request-changes", "Request changes"),
        ]
        .map(|(action, text)| {
            let on = self.review_action == action;
            div()
                .id(gpui::SharedString::from(format!("pr-review-{action}")))
                .debug_selector(move || format!("pr-review-choice-{action}"))
                .min_h(px(26.))
                .px(px(9.))
                .flex()
                .items_center()
                .rounded(px(7.))
                .border_1()
                .border_color(if on { theme().accent } else { theme().border })
                .text_size(px(11.))
                .text_color(if on { theme().text } else { theme().text_muted })
                .cursor_pointer()
                .child(text)
                .on_click(cx.listener(move |s, _, _, cx| {
                    s.review_action = action;
                    s.set_composer("review", cx);
                }))
        });
        let submit_action: &'static str = if review { self.review_action } else { "comment" };
        let can_submit = self.can(submit_action, "", cx);
        let open = string(d, "state").eq_ignore_ascii_case("open");
        div()
            .debug_selector(|| "pr-composer".into())
            .flex_shrink_0()
            .mx(px(12.))
            .mb(px(12.))
            .rounded(px(14.))
            .border_1()
            .border_color(theme().border)
            .bg(crate::theme::popover_background())
            .shadow_lg()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .py(px(7.))
                    .pl(px(12.))
                    .pr(px(10.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(self.mode_button("comment", "Comment", MESSAGE, cx))
                    .child(self.mode_button("review", "Review", CHECK_CIRCLE, cx))
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("pr-composer-collapse")
                            .debug_selector(|| "pr-composer-collapse".into())
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(7.))
                            .cursor_pointer()
                            .hover(|b| b.bg(theme().hover))
                            .child(icon(CHEVRON, 15.))
                            .on_click(cx.listener(|s, _, _, cx| {
                                s.composer = "";
                                s.changed(cx);
                            })),
                    ),
            )
            .child(notice(format!(
                "Posts to {} · PR #{number} on GitHub.",
                if repo.is_empty() { "the connected repository" } else { &repo }
            )))
            .when(review, |c| {
                c.child(div().flex().gap(px(6.)).px(px(14.)).pt(px(8.)).children(choices)).child(
                    if current {
                        notice(format!("Reviewing commit {}.", head.chars().take(7).collect::<String>()))
                    } else {
                        notice(if self.review_head.is_empty() {
                            "Load the current commit before reviewing.".into()
                        } else {
                            "This pull request has a newer commit.".into()
                        })
                        .text_color(theme().warning)
                        .child(
                            div()
                                .id("pr-review-head")
                                .debug_selector(|| "pr-review-head".into())
                                .mt(px(4.))
                                .text_color(theme().accent)
                                .cursor_pointer()
                                .child("Use latest commit")
                                .on_click(cx.listener(|s, _, _, cx| {
                                    s.review_head = string(&s.detail, "headSha").into();
                                    s.changed(cx);
                                })),
                        )
                    },
                )
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .pt(px(10.))
                    .px(px(14.))
                    .pb(px(10.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .min_h(px(44.))
                            .max_h(px(120.))
                            .text_size(px(12.))
                            .child(self.editor.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_end()
                            .gap(px(6.))
                            .when(!review && open, |row| {
                                let enabled = self.can("close-with-comment", "", cx);
                                row.child(
                                    action_button("pr-close-with-comment".into(), false, enabled)
                                        .bg(gpui::transparent_black())
                                        .text_color(theme().danger)
                                        .child("Close with comment")
                                        .on_click(cx.listener(|s, _, _, cx| s.prepare("close-with-comment", "", cx))),
                                )
                            })
                            .child(
                                action_button(format!("pr-{submit_action}"), can_submit, can_submit)
                                    .when(!can_submit, |b| b.text_color(theme().text_muted))
                                    .child(if self.delivery(cx).busy {
                                        "Submitting…"
                                    } else if review {
                                        "Submit review"
                                    } else {
                                        "Post comment"
                                    })
                                    .child(crate::icon::stroke(
                                        ARROW_UP,
                                        if can_submit { gpui::white().into() } else { theme().text_muted },
                                        13.,
                                        1.8,
                                    ))
                                    .on_click(cx.listener(move |s, _, _, cx| s.prepare(submit_action, "", cx))),
                            ),
                    ),
            )
            .into_any_element()
    }

    pub(super) fn detail_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(number) = self.selected else {
            return div()
                .p(px(18.))
                .text_size(px(12.))
                .text_color(theme().text_muted)
                .child("Select a pull request to read changes, checks and discussion.")
                .into_any_element();
        };
        let mut panel = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .text_color(theme().text);
        // Beside the standalone list, the detail can return to it.
        if self.contextual.is_none() {
            panel = panel.child(
                div().flex().justify_end().px(px(18.)).pt(px(10.)).child(
                    action_button("pr-detail-close".into(), false, true)
                        .child("Back to list")
                        .on_click(cx.listener(|s, _, w, cx| {
                            s.selected = None;
                            s.detail_epoch += 1;
                            s.confirmation = None;
                            s.focus.focus(w);
                            s.changed(cx);
                        })),
                ),
            );
        }
        if self.detail.is_null() {
            let status = if !self.detail_error.is_empty() {
                div()
                    .text_color(theme().danger)
                    .child(self.detail_error.clone())
                    .child(
                        action_button("pr-detail-retry".into(), false, !self.detail_loading)
                            .mt(px(8.))
                            .child("Retry")
                            .on_click(cx.listener(move |s, _, _, cx| s.select(number, cx))),
                    )
            } else {
                div().text_color(theme().text_muted).child(format!("Loading PR #{number}…"))
            };
            return panel.child(div().p(px(18.)).text_size(px(12.)).child(status)).into_any_element();
        }
        if !self.detail_error.is_empty() {
            panel = panel.child(
                div()
                    .px(px(18.))
                    .pt(px(10.))
                    .text_size(px(11.))
                    .text_color(theme().danger)
                    .child(self.detail_error.clone()),
            );
        }
        panel
            .child(self.header(number, cx))
            .child(self.tabs(cx))
            .child(
                div()
                    .id("pr-detail-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(self.tab_body(cx)),
            )
            // As PrBrainComposer, it opens from Write a comment or Submit a review.
            .when(!self.composer.is_empty(), |panel| panel.child(self.composer(cx)))
            .into_any_element()
    }
}

#[path = "detail_tabs.rs"]
mod tabs;
