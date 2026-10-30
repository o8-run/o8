//! O8ProblemDossiers: independent reads and body-bound decision receipts.
use super::*;

pub(super) struct Decisions {
    pub dossiers: Vec<Value>,
    pub open: bool,
    pub expanded: Option<String>,
    pub loading: bool,
    pub read_generation: u64,
    pub error: Option<String>,
    pub pending: HashMap<String, Value>,
    pub refreshed: Option<Instant>,
}
pub(super) fn actions(dossier: &Value) -> &'static [&'static str] {
    match dossier["status"].as_str().unwrap_or("") {
        "suppressed" => &["resume"],
        "candidate" | "reopened" => &["accept", "suppress"],
        "verified_closed" => &[],
        _ => &["stop"],
    }
}
impl ActivityPane {
    pub(crate) fn load_dossiers(&mut self, cx: &mut Context<Self>) {
        if self.decisions.loading {
            return;
        }
        self.decisions.loading = true;
        let client = self.client.clone();
        let generation = self.decisions.read_generation;
        let task = cx.background_executor().spawn(async move {
            client
                .activity_request(
                    "GET",
                    "/api/panel/problem-dossiers",
                    &[("includeSuppressed", "true")],
                    None,
                )
                .and_then(|v| {
                    v["dossiers"]
                        .as_array()
                        .cloned()
                        .ok_or_else(ReadError::invalid)
                })
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                if generation != s.decisions.read_generation {
                    return;
                }
                s.decisions.loading = false;
                s.decisions.refreshed = Some(Instant::now());
                match result {
                    Ok(rows) => {
                        s.decisions.dossiers = rows;
                        s.decisions.error = None;
                    }
                    Err(e) => s.decisions.error = Some(e.message),
                }
                s.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub(super) fn dossier_decision(
        &mut self,
        id: String,
        action: &'static str,
        cx: &mut Context<Self>,
    ) {
        if self.decisions.pending.contains_key(&id) {
            return;
        }
        let Some(dossier) = self.decisions.dossiers.iter().find(|d| d["id"] == id) else {
            return;
        };
        if !actions(dossier).contains(&action) {
            return;
        }
        let mut body = json!({"action":action,"dossierId":id,"clientMutationId":format!("next-dossier-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos())});
        if action == "suppress" {
            body["cooldownDays"] = json!(7);
        }
        self.decisions.pending.insert(id.clone(), body.clone());
        self.decisions.error = None;
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { decide(&client, &body) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                match result {
                    Ok(()) => {
                        s.decisions.pending.remove(&id);
                        s.decisions.read_generation += 1;
                        s.decisions.loading = false;
                        s.load_dossiers(cx);
                    }
                    Err((settled, error)) => {
                        if settled {
                            s.decisions.pending.remove(&id);
                        }
                        s.decisions.error = Some(error);
                    }
                }
                s.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
}
// A network retry must poll the same persisted decision, never start another.
fn decide(client: &Client, body: &Value) -> Result<(), (bool, String)> {
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        let url = client
            .url("/api/panel/problem-dossiers")
            .map_err(|e| (true, e.to_string()))?;
        let response = client.request("POST", &url).send_json(body.clone());
        let response = match response {
            Ok(r) | Err(ureq::Error::Status(_, r)) => Some(r),
            Err(_) => None,
        };
        if let Some(response) = response {
            let status = response.status();
            if let Ok(value) = Client::read::<Value>(response) {
                if value["outcomeUnknown"] == true {
                    return Err((
                        false,
                        value["error"]
                            .as_str()
                            .unwrap_or(
                                "This decision needs manual inspection before another action.",
                            )
                            .into(),
                    ));
                }
                if status != 202 && value["inProgress"] != true && value["status"] != "in_progress"
                {
                    if status < 300 && value["ok"] == true {
                        return Ok(());
                    }
                    return Err((
                        true,
                        value["error"]
                            .as_str()
                            .unwrap_or("Unable to apply this problem decision.")
                            .into(),
                    ));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err((false,"This decision is still unsettled. Inspect the dossier before taking another action.".into()));
        }
        std::thread::sleep(Duration::from_millis(750));
    }
}

impl Default for Decisions {
    fn default() -> Self {
        Self {
            dossiers: vec![],
            open: true,
            expanded: None,
            loading: false,
            read_generation: 0,
            error: None,
            pending: HashMap::new(),
            refreshed: None,
        }
    }
}
