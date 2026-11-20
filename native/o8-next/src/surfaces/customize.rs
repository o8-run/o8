use super::*;
use serde_json::Value;
#[path = "customize/inventory.rs"]
mod inventory;
#[path = "customize/plugins.rs"]
mod plugins;
#[path = "customize/view.rs"]
mod view;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<view::Customize>>,
    pub open: bool,
    closing: Option<gpui::Subscription>,
}
pub(super) const REGISTRATION: Registration = Registration {
    overlay_command: true,
    overlay: |s| {
        s.surfaces
            .customize
            .view
            .as_ref()
            .filter(|_| s.surfaces.customize.open)
            .map(|v| v.clone().into_any_element())
    },
    overlay_open: |s| s.surfaces.customize.open,
    key_down: |s, event, window, cx| {
        if !s.surfaces.customize.open {
            return false;
        }
        if event.keystroke.key == "escape" && !event.keystroke.modifiers.modified() {
            s.close_customize(window, cx);
            return true;
        }
        (event.keystroke.modifiers.control || event.keystroke.modifiers.platform)
            && ["k", "w", "tab"].contains(&event.keystroke.key.as_str())
    },
    ..Registration::new("", "Open Customize", |s, _, window, cx| {
        s.open_customize(window, cx);
        None
    })
};
impl Shell {
    fn open_customize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.surfaces.customize.open {
            return;
        }
        self.capture(window, cx);
        self.palette = false;
        if !self
            .surfaces
            .customize
            .view
            .as_ref()
            .is_some_and(|v| v.read(cx).belongs_to(self.state.selected.as_deref()))
        {
            let view = cx.new(|cx| {
                view::Customize::new(self.client.clone(), self.state.selected.clone(), cx)
            });
            self.surfaces.customize.closing = Some(cx.subscribe_in(
                &view,
                window,
                |this, _, _: &view::Close, window, cx| this.close_customize(window, cx),
            ));
            self.surfaces.customize.view = Some(view);
        }
        self.surfaces.customize.open = true;
        // The menu that opened the page is gone; without this no key reaches it.
        self.focus.focus(window);
        self.revision += 1;
        cx.notify();
    }
    /// Opens the page on one tab; the rail's Plugins button lands on its tab.
    pub(crate) fn show_customize_tab(
        &mut self,
        tab: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.surfaces.customize.open {
            self.close_rail_overlays(window, cx);
            self.execute(Command::Customize, window, cx);
        }
        if let Some(view) = self.surfaces.customize.view.clone() {
            view.update(cx, |view, cx| view.select_tab(tab, cx));
        }
    }
    pub(crate) fn customize_tab_open(&self, tab: &str, cx: &App) -> bool {
        self.surfaces.customize.open
            && self
                .surfaces
                .customize
                .view
                .as_ref()
                .is_some_and(|view| view.read(cx).tab_is(tab))
    }
    pub(crate) fn close_customize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.surfaces.customize.open = false;
        self.restore_focus(window, cx);
        self.revision += 1;
        cx.notify();
    }
}
impl Client {
    /// Keep the existing request/refusal contract with the surface registration.
    fn customize_request(&self, method: &str, path: &str, body: &Value) -> Result<Value, String> {
        let url = self.url(path).map_err(|_| "Invalid project route")?;
        let request = self.request(method, &url);
        let response = if method == "GET" {
            request.call()
        } else {
            request.send_json(body.clone())
        };
        match response {
            Ok(response) => Self::read(response),
            Err(ureq::Error::Status(status, response)) => {
                let data = Self::read::<Value>(response).unwrap_or(Value::Null);
                let message = data["error"]["message"].as_str().or(data["error"].as_str()).unwrap_or("Project request refused");
                let note = data["note"].as_str().unwrap_or("");
                Err(format!("{} (HTTP {status}). {}", message.chars().take(512).collect::<String>(), note.chars().take(512).collect::<String>()))
            }
            Err(_) => Err("Could not reach the selected server. Refresh to check saved state before retrying.".into()),
        }
    }
}

#[cfg(test)]
#[path = "customize/tests.rs"]
mod tests;

#[cfg(test)]
mod prompt_writer_tests {
    use super::*;

    #[test]
    #[ignore = "driven by the owned saved-prompt product transport fixture"]
    fn saved_prompt_writes_without_node() {
        let root = std::path::PathBuf::from(std::env::var_os("O8_PROMPT_CLIENT_DATA").unwrap());
        assert_eq!(std::fs::read_to_string(root.join("fixture-owner")).unwrap(), "o8d-native-read/v1");
        assert_eq!(std::fs::read_to_string(root.join("node-stopped")).unwrap(), "stopped");
        let token = std::fs::read_to_string(root.join("ws-token")).unwrap();
        let client = Client::authenticated(&std::env::var("O8_PROMPT_CLIENT_ORIGIN").unwrap(), Some(token.trim().to_owned())).unwrap();
        let state = root.join("prompt-client-write-state.json");
        if !state.exists() {
            let created = client.customize_request("POST", "/api/prompt-library", &serde_json::json!({"title":"fixture native workflow", "body":"created by the actual window Client", "tags":["fixture"]})).unwrap();
            assert_eq!(created["created"], true);
            let id = created["prompt"]["id"].as_str().unwrap();
            let path = format!("/api/prompt-library/{id}");
            let edited = client.customize_request("PATCH", &path, &serde_json::json!({"title":"fixture native edited", "expectedUpdatedAt":created["prompt"]["updatedAt"]})).unwrap();
            assert_eq!(edited["prompt"]["title"], "fixture native edited");
            let used = client.customize_request("POST", &format!("{path}/use"), &serde_json::json!({})).unwrap();
            assert_eq!(used["prompt"]["useCount"], 1);
            assert!(used["prompt"]["lastUsedAt"].as_i64().unwrap() > 0);
            std::fs::write(&state, serde_json::to_vec(&used["prompt"]).unwrap()).unwrap();
        } else {
            // This phase is run after the fixture restarts o8d with Node still stopped.
            let saved: Value = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
            let id = saved["id"].as_str().unwrap();
            let path = format!("/api/prompt-library/{id}");
            let opened = client.customize_request("GET", &path, &Value::Null).unwrap();
            assert_eq!(opened["prompt"], saved);
            let listed: Value = client.get("/api/prompt-library", &[("scope", "all")]).unwrap();
            assert_eq!(listed["prompts"][0], saved);
            let deleted = client.customize_request("DELETE", &format!("{path}?expectedUpdatedAt={}", saved["updatedAt"]), &Value::Null).unwrap();
            assert_eq!(deleted["deletedId"], id);
            assert!(client.customize_request("GET", &path, &Value::Null).unwrap_err().contains("HTTP 404"));
        }
    }
}
