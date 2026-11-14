//! Thread status from the existing server PR context and panel detail routes.
use super::*;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct PrStatus {
    thread: Option<String>,
    generation: u64,
    target: Option<(String, u64)>,
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
fn linked_pr(links: &[crate::shell::sidebar::PrLink]) -> Option<(String, u64)> {
    links
        .iter()
        .find(|link| link.state.as_deref() == Some("open"))
        .or_else(|| links.first())
        .map(|link| (link.repository_full_name.clone(), link.number))
}
fn read(client: &Client, repo: &str, number: u64) -> Result<Option<Value>, String> {
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
    pub(crate) fn bind_pr_links(
        &mut self,
        source: gpui::Entity<crate::shell::sidebar::ThreadList>,
        cx: &mut Context<Self>,
    ) {
        self.subscriptions
            .push(cx.observe(&source, |_, _, cx| cx.notify()));
        self.pr_link_source = Some(source);
    }

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
        // The sidebar already discovers explicit PR links. Rendering a thread
        // without one must not start HTTP work or a refresh timer.
        let Some(source) = &self.pr_link_source else {
            return;
        };
        let target = thread
            .as_ref()
            .and_then(|id| linked_pr(source.read(cx).links_for(id)));
        let state = &mut self.changes_pill.pr;
        if state.thread != thread || state.target != target {
            *state = PrStatus {
                thread: thread.clone(),
                target: target.clone(),
                generation: state.generation + 1,
                ..Default::default()
            };
        }
        let Some((repo, number)) = target else { return };
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
            .spawn(async move { read(&client, &repo, number) });
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

    pub(super) fn pr_status_pill(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        if self.changes_pill.pr.focus.is_none() {
            self.changes_pill.pr.focus = Some(cx.focus_handle());
        }
        let state = &self.changes_pill.pr;
        let pr = state.detail.as_ref().unwrap();
        let rows = checks(pr);
        let tint = color(&rows);
        let focus = state.focus.as_ref().unwrap();
        let viewport = window.viewport_size();
        let card_width = (f32::from(viewport.width) - 24.).clamp(0., 380.);
        let card_height =
            (80. + rows.len().min(12) as f32 * 36.).min((f32::from(viewport.height) - 24.).max(0.));
        let position = self
            .composer
            .read(cx)
            .controls
            .prompt
            .anchors
            .get("pr-status")
            .map(|bounds| {
                gpui::point(
                    bounds.center().x - px(card_width / 2.),
                    bounds.top() - px(8.),
                )
            })
            .unwrap_or_else(|| {
                gpui::point(
                    (viewport.width - px(card_width)) / 2.,
                    viewport.height - px(PILL_HEIGHT + 8.),
                )
            });
        let mut card = div()
            .id("composer-pr-card")
            .debug_selector(|| "composer-pr-card".into())
            .occlude()
            .w(px(card_width))
            .min_w_0()
            .min_h_0()
            .p(px(12.))
            .rounded(px(10.))
            .border_1()
            .border_color(theme().border)
            .bg(crate::theme::popover_background())
            .shadow(floating_shadow())
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(div().flex_shrink_0().min_w_0().truncate().child(format!(
                "#{} · {}",
                pr["number"],
                pr["title"].as_str().unwrap_or("")
            )))
            .child(
                div()
                    .flex_shrink_0()
                    .truncate()
                    .text_color(theme().text_secondary)
                    .child(
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
            .debug_selector(|| "composer-pr-checks".into())
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .gap(px(4.))
            .max_h(px(432.))
            .overflow_y_scroll()
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
                    .debug_selector(move || format!("composer-pr-check-{index}"))
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
                            .w(gpui::relative(
                                seconds.unwrap_or(0) as f32 / max_duration as f32,
                            ))
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
            .max_h(px(card_height * crate::motion::ease_out(progress)))
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
        root.text_style()
            .get_or_insert_with(Default::default)
            .font_features = Some(gpui::FontFeatures(std::sync::Arc::new(vec![(
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
                    gpui::anchored()
                        .position(position)
                        .anchor(gpui::Corner::BottomLeft)
                        .snap_to_window_with_margin(px(12.))
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
        let links = serde_json::from_value::<Vec<crate::shell::sidebar::PrLink>>(json!([
            {"repositoryFullName":"example/repo","number":1,"state":"merged"},
            {"repositoryFullName":"example/repo","number":2,"state":"open"}
        ]))
        .unwrap();
        assert_eq!(linked_pr(&links), Some(("example/repo".into(), 2)));
        assert!(linked_pr(&[]).is_none());
    }
}
