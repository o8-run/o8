use super::*;
use serde_json::Value;
#[path = "customize/view.rs"]
mod view;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<view::Customize>>,
    pub open: bool,
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
    focus_overlay: |s, window, cx| {
        if s.surfaces.customize.open
            && let Some(view) = &s.surfaces.customize.view
        {
            view.read(cx).focus.focus(window);
            true
        } else {
            false
        }
    },
    nav: |s, position, cx| {
        if position != NavPosition::BeforeWorkspaces {
            return vec![];
        }
        let mut nav = vec![
            div()
                .id("customize-open")
                .debug_selector(|| "customize-open".into())
                .p(px(6.))
                .cursor_pointer()
                .child("Customize")
                .on_click(cx.listener(|s, _, window, cx| s.execute(Command::Customize, window, cx)))
                .into_any_element(),
        ];
        if s.surfaces.customize.open {
            nav.push(
                div()
                    .id("customize-close")
                    .debug_selector(|| "customize-close".into())
                    .p(px(6.))
                    .cursor_pointer()
                    .child("Close Customize")
                    .on_click(cx.listener(|s, _, window, cx| s.close_customize(window, cx)))
                    .into_any_element(),
            );
        }
        nav
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
            self.surfaces.customize.view = Some(cx.new(|cx| {
                view::Customize::new(self.client.clone(), self.state.selected.clone(), cx)
            }));
        }
        self.surfaces.customize.open = true;
        self.restore_focus(window, cx);
        self.revision += 1;
        cx.notify();
    }
    fn close_customize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .surfaces
            .customize
            .view
            .as_ref()
            .is_some_and(|v| v.read(cx).busy())
        {
            return;
        }
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
                let message = data["error"].as_str().unwrap_or("Project request refused");
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
