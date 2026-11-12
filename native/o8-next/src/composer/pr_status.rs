//! Thread status from the existing server PR context and panel detail routes.
use super::*;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct PrStatus {
    thread: Option<String>,
    generation: u64,
    loading: bool,
    read_at: Option<Instant>,
    pub(super) detail: Option<Value>,
    open: bool,
    opened: Option<Instant>,
    focus: Option<gpui::FocusHandle>,
}

fn failed(check: &Value) -> bool {
    matches!(
        check["conclusion"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "failure" | "cancelled" | "timed_out" | "action_required" | "startup_failure" | "stale"
    )
}
fn passed(check: &Value) -> bool {
    matches!(
        check["conclusion"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "success" | "neutral" | "skipped"
    )
}
fn checks(pr: &Value) -> Vec<Value> {
    let mut rows = pr["statusCheckRollup"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    rows.sort_by_key(|c| (!failed(c), c["name"].as_str().unwrap_or("").to_owned()));
    rows
}
fn label(pr: &Value) -> String {
    let rows = checks(pr);
    format!(
        "#{} · Checks {}/{}",
        pr["number"].as_u64().unwrap_or(0),
        rows.iter().filter(|c| passed(c)).count(),
        rows.len()
    )
}
fn color(rows: &[Value]) -> gpui::Rgba {
    if rows.iter().any(failed) {
        theme().danger
    } else if !rows.is_empty() && rows.iter().all(passed) {
        theme().success
    } else {
        theme().accent
    }
}
fn duration(check: &Value) -> Option<u64> {
    // Older panel servers omit timing; unknown is never displayed as zero.
    check["durationMs"].as_u64().map(|ms| ms / 1000)
}
fn linked_pr(body: &Value) -> Option<&Value> {
    let links = body["result"]["links"].as_array()?;
    links
        .iter()
        .find(|l| l["state"] == "open")
        .or_else(|| links.first())
}
fn read(client: &Client, thread: &str) -> Result<Option<Value>, String> {
    let body = client
        .get::<Value>(
            "/api/orchestrator/pull-request-context",
            &[("threadId", thread), ("limit", "100")],
        )
        .map_err(|e| e.to_string())?;
    if body["result"]["links"].as_array().is_none() {
        return Err("PR context unavailable".into());
    }
    let Some(link) = linked_pr(&body) else {
        return Ok(None);
    };
    let repo = link["repositoryFullName"]
        .as_str()
        .ok_or("Missing repository")?;
    let number = link["number"].as_u64().ok_or("Missing PR number")?;
    let body = client
        .get::<Value>(
            &format!("/api/panel/prs/{number}"),
            &[("repo", repo), ("poll", "1")],
        )
        .map_err(|e| e.to_string())?;
    let mut pr = body["pr"].clone();
    if pr["number"].as_u64() != Some(number) {
        return Err("PR detail unavailable".into());
    }
    // Bind supplementary timing to the same head. A failed read keeps unknowns.
    if let Ok(extra) = client.get::<Value>(
        &format!("/api/panel/prs/{number}/checks"),
        &[("repo", repo)],
    ) {
        if extra["headSha"] == pr["headSha"] {
            pr["mergeable"] = extra["mergeable"].clone();
            if let Some(rows) = pr["statusCheckRollup"].as_array_mut() {
                for row in rows {
                    if let Some(timing) = extra["timings"]
                        .as_array()
                        .and_then(|ts| ts.iter().find(|t| t["name"] == row["name"]))
                    {
                        row["durationMs"] = timing["durationMs"].clone();
                    }
                }
            }
        } else {
            pr["mergeable"] = Value::Null;
        }
    } else {
        pr["mergeable"] = Value::Null;
    }
    Ok(Some(pr))
}

impl Surface {
    #[cfg(test)]
    pub(crate) fn fixture_pr_status(&mut self, detail: Value) {
        self.changes_pill.pr = PrStatus {
            thread: self.selected.clone(),
            read_at: Some(Instant::now()),
            detail: Some(detail),
            ..Default::default()
        };
    }

    pub(super) fn sync_pr_status(&mut self, cx: &mut Context<Self>) {
        let thread = self
            .selected
            .clone()
            .filter(|id| id.starts_with("thoughts-"));
        let state = &mut self.changes_pill.pr;
        if state.thread != thread {
            *state = PrStatus {
                thread: thread.clone(),
                generation: state.generation + 1,
                ..Default::default()
            };
        }
        let Some(thread) = thread else { return };
        if state.loading
            || state
                .read_at
                .is_some_and(|at| at.elapsed() < Duration::from_secs(15))
        {
            return;
        }
        state.loading = true;
        let generation = state.generation;
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { read(&client, &thread) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                let state = &mut this.changes_pill.pr;
                if generation != state.generation {
                    return;
                }
                state.loading = false;
                state.read_at = Some(Instant::now());
                if let Ok(detail) = result {
                    state.detail = detail;
                }
                cx.notify();
            });
            cx.background_executor()
                .timer(Duration::from_secs(15))
                .await;
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }

    pub(super) fn pr_status_pill(&mut self, cx: &mut Context<Self>) -> gpui::AnyElement {
        if self.changes_pill.pr.focus.is_none() {
            self.changes_pill.pr.focus = Some(cx.focus_handle());
        }
        let state = &self.changes_pill.pr;
        let pr = state.detail.as_ref().unwrap();
        let rows = checks(pr);
        let tint = color(&rows);
        let focus = state.focus.as_ref().unwrap();
        let mut card = div()
            .id("composer-pr-card")
            .debug_selector(|| "composer-pr-card".into())
            .occlude()
            .w(px(380.))
            .p(px(12.))
            .rounded(px(10.))
            .border_1()
            .border_color(theme().border)
            .bg(crate::theme::popover_background())
            .shadow(floating_shadow())
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(div().child(format!(
                "#{} · {}",
                pr["number"],
                pr["title"].as_str().unwrap_or("")
            )))
            .child(
                div().text_color(theme().text_secondary).child(
                    pr["headSha"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(7)
                        .collect::<String>(),
                ),
            );
        let max_duration = rows.iter().filter_map(duration).max().unwrap_or(1).max(1);
        let list = div()
            .id("composer-pr-checks")
            .flex()
            .flex_col()
            .gap(px(4.))
            .when(rows.len() > 12, |d| d.max_h(px(432.)).overflow_y_scroll())
            .children(rows.iter().enumerate().map(|(index, check)| {
                let url = check["url"]
                    .as_str()
                    .filter(|url| url.starts_with("https://"))
                    .map(str::to_owned);
                let seconds = duration(check);
                let text = if failed(check) {
                    "Failed"
                } else if passed(check) {
                    "Passed"
                } else {
                    "Running"
                };
                div()
                    .id(("composer-pr-check", index))
                    .h(px(32.))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .hover(|d| d.bg(theme().hover))
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .gap(px(8.))
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .child(check["name"].as_str().unwrap_or("Check").to_owned()),
                            )
                            .child(format!(
                                "{} · {text}",
                                seconds
                                    .map(|s| format!("{}:{:02}", s / 60, s % 60))
                                    .unwrap_or("—".into())
                            )),
                    )
                    .child(
                        div()
                            .h(px(1.))
                            .w(px(340. * seconds.unwrap_or(0) as f32 / max_duration as f32))
                            .bg(tint),
                    )
                    .on_click(cx.listener(move |_, _, _, cx| {
                        if let Some(url) = &url {
                            cx.open_url(url);
                        }
                    }))
            }));
        card = card.child(list);
        let progress = state
            .opened
            .map(|at| (at.elapsed().as_secs_f32() / 0.18).min(1.))
            .unwrap_or(1.);
        if state.open && progress < 1. {
            cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let _ = this.update(cx, |_, cx| cx.notify());
            })
            .detach();
        }
        card = card
            .opacity(crate::motion::ease_out(progress))
            .max_h(px(
                (80. + rows.len().min(12) as f32 * 36.) * crate::motion::ease_out(progress)
            ))
            .overflow_hidden()
            .on_mouse_down_out(cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                if this
                    .composer
                    .read(cx)
                    .controls
                    .prompt
                    .anchors
                    .get("pr-status")
                    .is_some_and(|bounds| bounds.contains(&event.position))
                {
                    return;
                }
                this.changes_pill.pr.open = false;
                cx.notify();
            }));
        let pill = div()
            .id("composer-pr-pill")
            .debug_selector(|| "composer-pr-pill".into())
            .track_focus(focus)
            .tab_index(0)
            .occlude()
            .h(px(PILL_HEIGHT - 2.))
            .px(px(11.))
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded_full()
            .border_1()
            .border_color(theme().border)
            .bg(floating_glass())
            .shadow(floating_shadow())
            .cursor_pointer()
            .hover(|d| d.bg(theme().hover))
            .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                let state = &mut this.changes_pill.pr;
                state.open = !state.open;
                state.opened = (!event.is_keyboard()).then(Instant::now);
                state.focus.as_ref().unwrap().focus(window);
                cx.notify();
            }))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                match event.keystroke.key.as_str() {
                    "escape" => {
                        this.changes_pill.pr.open = false;
                        cx.stop_propagation();
                    }
                    "enter" | "space" => {
                        this.changes_pill.pr.open = !this.changes_pill.pr.open;
                        this.changes_pill.pr.opened = None;
                        cx.stop_propagation();
                    }
                    _ => return,
                }
                cx.notify();
            }))
            .child(div().size(px(5.)).rounded_full().bg(tint))
            .child(label(pr));
        let pill = self.track_prompt_anchor(pill, "pr-status");
        let mut root = div()
            .relative()
            .w_full()
            .h(px(0.))
            .text_size(px(12.))
            .text_color(theme().text);
        root.text_style().get_or_insert_with(Default::default).font_features = Some(gpui::FontFeatures(std::sync::Arc::new(vec![(
            "tnum".into(),
            1,
        )])));
        root.child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom(px(8.))
                .flex()
                .justify_center()
                .gap(px(6.))
                .child(pill)
                .when(self.away_from_end, |d| d.child(self.jump_arrow(cx))),
        )
        .when(state.open, |d| {
            d.child(
                gpui::deferred(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom(px(PILL_HEIGHT + 8.))
                        .flex()
                        .justify_center()
                        .child(card),
                )
                .with_priority(1),
            )
        })
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn checks_progress_and_failures() {
        let pr = json!({"number":128,"statusCheckRollup":[
            {"name":"pass","conclusion":"success"}, {"name":"run","status":"in_progress"},
            {"name":"fail","conclusion":"failure"}]});
        assert_eq!(label(&pr), "#128 · Checks 1/3");
        assert_eq!(checks(&pr)[0]["name"], "fail");
        assert_eq!(label(&json!({"number":128})), "#128 · Checks 0/0");
        assert_eq!(duration(&json!({})), None);
        assert_eq!(duration(&json!({"durationMs":61000})), Some(61));
    }
    #[test]
    fn selects_open_context_and_detects_unlink() {
        let body =
            json!({"result":{"links":[{"number":1,"state":"merged"},{"number":2,"state":"open"}]}});
        assert_eq!(linked_pr(&body).unwrap()["number"], 2);
        assert!(linked_pr(&json!({"result":{"links":[]}})).is_none());
    }
}
