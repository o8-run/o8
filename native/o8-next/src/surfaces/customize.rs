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
