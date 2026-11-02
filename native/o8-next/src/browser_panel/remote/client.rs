//! Existing task preview routes; operator authority stays in Client and the server.
use crate::client::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Execution {
    pub job_id: String,
    pub attempt: u64,
    pub preview_access: String,
}
#[derive(Clone, Deserialize)]
pub(super) struct Task {
    pub id: String,
    pub title: String,
    pub execution: Option<Execution>,
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Access {
    pub id: Option<String>,
    pub url: Option<String>,
    pub service: Option<String>,
    pub service_job_id: Option<String>,
    pub status: Option<String>,
}
pub(super) enum Update {
    Progress(String),
    Ready(Access),
    Error(String),
}
pub(super) struct Owner {
    pub client: Client,
    pub task: Task,
    pub alive: AtomicBool,
    pub resource: Mutex<Access>,
}
impl Owner {
    pub fn new(client: Client, task: Task) -> Arc<Self> {
        Arc::new(Self {
            client,
            task,
            alive: AtomicBool::new(true),
            resource: Mutex::new(Access::default()),
        })
    }
    fn endpoint(&self) -> String {
        format!(
            "/api/tasks/{}/preview",
            url::form_urlencoded::byte_serialize(self.task.id.as_bytes()).collect::<String>()
        )
    }
    fn release(&self, access: &Access, keep: bool) {
        if access.id.is_none() && access.service_job_id.is_none() {
            return;
        }
        let Ok(url) = self.client.url(&self.endpoint()) else {
            return;
        };
        let _=self.client.request("DELETE",&url).timeout(Duration::from_secs(12))
            .send_json(json!({"id":access.id,"serviceJobId":access.service_job_id,"keepService":keep && self.alive.load(Ordering::SeqCst)}));
    }
    pub fn cancel(self: &Arc<Self>) {
        self.alive.store(false, Ordering::SeqCst);
        let access = self.resource.lock().unwrap().clone();
        let owner = self.clone();
        std::thread::spawn(move || owner.release(&access, false));
    }
    pub fn connect(self: Arc<Self>, reconnect: bool, tx: async_channel::Sender<Update>) {
        if reconnect {
            let access = self.resource.lock().unwrap().clone();
            self.release(&access, true);
        }
        let result = self.poll(&tx);
        if let Err(error) = result {
            let access = self.resource.lock().unwrap().clone();
            if self.alive.load(Ordering::SeqCst) {
                let _ = tx.send_blocking(Update::Error(error));
            }
            self.release(&access, false);
        }
    }
    fn poll(&self, tx: &async_channel::Sender<Update>) -> Result<(), String> {
        let execution = self
            .task
            .execution
            .as_ref()
            .ok_or("Remote execution is unavailable.")?;
        let until = Instant::now() + Duration::from_secs(60);
        while self.alive.load(Ordering::SeqCst) && Instant::now() < until {
            let url = self
                .client
                .url(&self.endpoint())
                .map_err(|_| "Remote preview is unavailable.")?;
            let service = self.resource.lock().unwrap().service_job_id.clone();
            let response=self.client.request("POST",&url).timeout(Duration::from_secs(12))
                .send_json(json!({"jobId":execution.job_id,"attempt":execution.attempt,"serviceJobId":service}))
                .map_err(|_|"Remote preview is unavailable. Reconnect to try again.")?;
            let queued = response.status() == 202;
            let body: Access = Client::read(response)?;
            *self.resource.lock().unwrap() = body.clone();
            if !self.alive.load(Ordering::SeqCst) {
                self.release(&body, false);
                return Ok(());
            }
            if !queued {
                if !super::web::valid_access(&body) {
                    return Err("Remote preview returned no usable connection.".into());
                }
                if tx.send_blocking(Update::Ready(body.clone())).is_err() {
                    self.release(&body, false);
                }
                return Ok(());
            }
            if body.service_job_id.is_none() {
                return Err("Remote service returned no session.".into());
            }
            let stage = if body.status.as_deref() == Some("queued") {
                "Waiting for a remote worker…"
            } else {
                "Starting the review service…"
            };
            if tx.send_blocking(Update::Progress(stage.into())).is_err() {
                self.release(&body, false);
                return Ok(());
            }
            // Bound cancellation latency between polls without abandoning an allocation response.
            for _ in 0..10 {
                if !self.alive.load(Ordering::SeqCst) {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if self.alive.load(Ordering::SeqCst) {
            Err("The review service did not become ready. Reconnect to try again.".into())
        } else {
            Ok(())
        }
    }
}
pub(super) fn tasks(client: &Client) -> Result<Vec<Task>, String> {
    let root = client
        .workspace()
        .ok_or("Select a project to see remote previews.")?;
    let body: Value = client.get("/api/tasks", &[("repoPath", root), ("includeDone", "true")])?;
    let tasks: Vec<Task> = serde_json::from_value(body["tasks"].clone())
        .map_err(|_| "Remote task list is unavailable.")?;
    Ok(tasks
        .into_iter()
        .filter(|task| {
            task.execution.as_ref().is_some_and(|e| {
                e.preview_access == "requestable" && e.attempt > 0 && !e.job_id.is_empty()
            })
        })
        .collect())
}
