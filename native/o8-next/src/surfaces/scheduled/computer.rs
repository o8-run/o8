//! Everything scheduled on this Mac: launchd agents and daemons and the
//! crontab, as `GET /api/automations/computer` reads them. Read when the page
//! opens and on Refresh, never on the 15-second tick, and sent as the app's own
//! read so it does not wake a resting server's background work. The user's own
//! jobs can be stopped or disabled after a confirmation that names the job and
//! what it runs, and each change offers an undo.
use super::*;

pub(super) const PATH: &str = "/api/automations/computer";

/// The app's own read: `x-o8-foreground: 0` even right after a click.
pub(super) fn read_computer(client: &Client) -> Result<Value, String> {
    let url = client.url(PATH).map_err(|_| "Invalid route".to_owned())?;
    let request = client
        .request("GET", &url)
        .set(crate::foreground::HEADER, "0");
    match request.call() {
        Ok(response) => Client::read::<Value>(response),
        Err(ureq::Error::Status(status, response)) => {
            let data = Client::read::<Value>(response).unwrap_or(Value::Null);
            Err(data["error"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Request refused (HTTP {status})")))
        }
        Err(_) => Err("Could not reach the selected server".into()),
    }
}

impl Scheduled {
    pub(super) fn load_computer(&mut self, cx: &mut Context<Self>) {
        if self.computer_in_flight {
            return;
        }
        self.computer_in_flight = true;
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { read_computer(&client) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.computer_in_flight = false;
                // A failed re-read keeps the list already on screen.
                if result.is_ok() || !matches!(this.computer, Some(Ok(_))) {
                    this.computer = Some(result);
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn computer_jobs(&self) -> Vec<Value> {
        match &self.computer {
            Some(Ok(data)) => data["jobs"].as_array().cloned().unwrap_or_default(),
            _ => vec![],
        }
    }

    /// The full list replaces the connected route's shorter launchd and cron rows.
    pub(super) fn computer_listed(&self) -> bool {
        matches!(&self.computer, Some(Ok(data)) if data["jobs"].is_array())
    }

    pub(super) fn computer_section(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let jobs = match &self.computer {
            None => {
                return Some(section_note("Reading this Mac's scheduled jobs…").into_any_element());
            }
            Some(Err(error)) => {
                return Some(
                    section_note(&format!("This Mac's scheduled jobs unavailable: {error}"))
                        .into_any_element(),
                );
            }
            Some(Ok(_)) => self.computer_jobs(),
        };
        if jobs.is_empty() {
            return None;
        }
        // launchd rows the connected route can start keep "Run now".
        let runnable: HashMap<String, String> = self
            .connected_jobs()
            .into_iter()
            .filter(|job| {
                job["agentId"] == "launchd" && job["readOnly"] != true && job["enabled"] == true
            })
            .filter_map(|job| {
                Some((
                    job["source"].as_str()?.to_owned(),
                    job["id"].as_str()?.to_owned(),
                ))
            })
            .collect();
        let count = jobs.len();
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(section_header("On this Mac", count))
                .when_some(self.computer_error.clone(), |section, error| {
                    section.child(section_note(&error))
                })
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(theme().border)
                        .bg(theme().surface)
                        .overflow_hidden()
                        .children(jobs.iter().enumerate().map(|(n, job)| {
                            let run = (job["scope"] == "user")
                                .then(|| {
                                    job["label"].as_str().and_then(|label| runnable.get(label))
                                })
                                .flatten()
                                .cloned();
                            self.computer_row(job, run, n + 1 == count, cx)
                        })),
                )
                .into_any_element(),
        )
    }

    /// Stop or disable after the row's confirmation named the job.
    fn change_computer(
        &mut self,
        id: String,
        label: String,
        action: &'static str,
        cx: &mut Context<Self>,
    ) {
        self.computer_confirm = None;
        self.send_computer(
            id.clone(),
            json!({ "id": id, "action": action, "confirm": label }),
            cx,
        );
    }

    fn undo_computer(&mut self, id: String, entry: String, cx: &mut Context<Self>) {
        self.send_computer(id, json!({ "undo": entry }), cx);
    }

    fn send_computer(&mut self, id: String, body: Value, cx: &mut Context<Self>) {
        let key = format!("computer:{id}");
        self.busy.insert(key.clone(), "change");
        self.computer_error = None;
        cx.notify();
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { call(&client, "POST", PATH, Some(body)) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy.remove(&key);
                if let Err(error) = result {
                    this.computer_error = Some(error);
                }
                this.load_computer(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn computer_row(
        &self,
        job: &Value,
        run: Option<String>,
        last: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = job["id"].as_str().unwrap_or("").to_owned();
        let label = job["label"].as_str().unwrap_or("").to_owned();
        let (status, color) = computer_status(job);
        let about = computer_about(job);
        let facts = computer_facts(job);
        let row = format!("scheduled-computer-{label}");
        let busy = self.busy.contains_key(&format!("computer:{id}"))
            || run
                .as_ref()
                .is_some_and(|run| self.busy.contains_key(&format!("connected:{run}")));
        let confirming = self
            .computer_confirm
            .as_ref()
            .filter(|(confirm, _)| *confirm == id)
            .map(|(_, action)| *action);
        let actions: Vec<&'static str> = job["actions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|action| match action.as_str() {
                Some("stop") => Some("stop"),
                Some("disable") => Some("disable"),
                _ => None,
            })
            .collect();
        let undo = job["undoEntryId"].as_str().map(str::to_owned);
        let reason = job["readOnlyReason"].as_str().map(str::to_owned);
        let mut controls = div().flex().items_center().gap(px(6.));
        if let Some(run_id) = run.filter(|_| confirming.is_none()) {
            controls = controls.child(
                action(format!("scheduled-run-{run_id}"), "Run now", false, busy).on_click(
                    cx.listener(move |this, _, _, cx| this.run_connected(run_id.clone(), cx)),
                ),
            );
        }
        if confirming.is_none() {
            for kind in actions {
                let (id, title) = (id.clone(), if kind == "stop" { "Stop" } else { "Disable" });
                controls = controls.child(
                    action(
                        format!("scheduled-computer-{kind}-{label}"),
                        title,
                        false,
                        busy,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.computer_confirm = Some((id.clone(), kind));
                        cx.notify();
                    })),
                );
            }
            if let Some(entry) = undo {
                let id = id.clone();
                controls = controls.child(
                    action(
                        format!("scheduled-computer-undo-{label}"),
                        "Undo",
                        false,
                        busy,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.undo_computer(id.clone(), entry.clone(), cx)
                    })),
                );
            }
            if let Some(reason) = reason {
                controls = controls.child(
                    div()
                        .max_w(px(220.))
                        .text_size(px(10.5))
                        .text_color(theme().text_faint)
                        .child(reason),
                );
            }
        }
        // The confirmation names the job and what it runs, under the row.
        let confirm = confirming.map(|kind| {
            let (id, name) = (id.clone(), label.clone());
            div()
                .debug_selector(move || format!("scheduled-computer-confirm-{name}"))
                .w_full()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .pl(px(21.))
                .text_size(px(11.5))
                .text_color(theme().text_secondary)
                .child(confirm_text(job, kind))
                .child(
                    action(
                        format!("scheduled-computer-confirm-{kind}-{label}"),
                        if kind == "stop" { "Stop" } else { "Disable" },
                        true,
                        busy,
                    )
                    .on_click(cx.listener({
                        let label = label.clone();
                        move |this, _, _, cx| {
                            this.change_computer(id.clone(), label.clone(), kind, cx)
                        }
                    })),
                )
                .child(
                    action(
                        format!("scheduled-computer-cancel-{label}"),
                        "Cancel",
                        false,
                        false,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.computer_confirm = None;
                        cx.notify();
                    })),
                )
        });
        div()
            .debug_selector(move || row)
            .min_h(px(52.))
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(14.))
            .px(px(14.))
            .py(px(8.))
            .when(!last, |row| row.border_b_1().border_color(theme().border))
            .child(div().size(px(7.)).rounded_full().flex_shrink_0().bg(color))
            .child(
                div()
                    .flex_1()
                    .min_w(px(180.))
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .when(job["disabled"] == true, |text| text.opacity(0.6))
                    .child(div().text_size(px(13.)).truncate().child(label.clone()))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .truncate()
                            .child(about),
                    ),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(14.))
                    .child(
                        div()
                            .w(px(110.))
                            .text_size(px(11.))
                            .text_color(color)
                            .truncate()
                            .child(status),
                    )
                    .child(
                        div()
                            .w(px(150.))
                            .text_size(px(11.))
                            .text_color(theme().text_secondary)
                            .truncate()
                            .child(facts),
                    )
                    .child(controls),
            )
            .children(confirm)
            .into_any_element()
    }
}

/// "Stop com.example.syncer? It runs /opt/tools/bin/syncer. …" — the job by name and what runs.
pub(super) fn confirm_text(job: &Value, kind: &str) -> String {
    let label = job["label"].as_str().unwrap_or("this job");
    let program = job["program"]
        .as_str()
        .map(|program| format!(" It runs {program}."))
        .unwrap_or_default();
    let effect = match (kind, job["scope"].as_str()) {
        (_, Some("cron")) => "Its crontab line is commented out, not removed.",
        ("stop", _) => {
            "Stops it for this login; it starts again at the next login unless disabled."
        }
        _ => "launchd will not start it, across logins, until you undo this.",
    };
    let verb = if kind == "stop" { "Stop" } else { "Disable" };
    format!("{verb} {label}?{program} {effect}")
}

/// Running, failed, off or idle, in words and color.
pub(super) fn computer_status(job: &Value) -> (String, gpui::Rgba) {
    let exit = job["lastExit"].as_str().filter(|code| *code != "0");
    if job["running"] == true {
        let pid = job["pid"]
            .as_u64()
            .map(|pid| format!(" · pid {pid}"))
            .unwrap_or_default();
        return (format!("Running{pid}"), theme().accent);
    }
    if job["disabled"] == true {
        return ("Disabled".into(), theme().text_faint);
    }
    if let Some(code) = exit {
        return (format!("Exit {code}"), theme().danger);
    }
    match job["loaded"].as_bool() {
        Some(true) => ("Loaded".into(), theme().success),
        Some(false) => ("Not loaded".into(), theme().text_faint),
        None => ("Scheduled".into(), theme().text_muted),
    }
}

/// What runs, when, and who made it.
pub(super) fn computer_about(job: &Value) -> String {
    let triggers = job["triggers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    let maker = match (job["maker"]["kind"].as_str(), job["maker"]["name"].as_str()) {
        (Some("o8"), _) => "o8".to_owned(),
        (Some("app"), Some(name)) => name.to_owned(),
        (Some("system"), Some(name)) => format!("system · {name}"),
        (_, Some(name)) => name.to_owned(),
        _ => String::new(),
    };
    [
        job["program"].as_str().unwrap_or("").to_owned(),
        triggers,
        maker,
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

/// Runs so far and the scope a system job sits in.
pub(super) fn computer_facts(job: &Value) -> String {
    let scope = match job["scope"].as_str() {
        Some("system-daemon") => Some("System daemon"),
        Some("system-agent") => Some("System agent"),
        Some("cron") => Some("crontab"),
        _ => None,
    };
    let runs = job["runs"].as_u64().map(|runs| format!("{runs} runs"));
    [scope.map(str::to_owned), runs]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}
