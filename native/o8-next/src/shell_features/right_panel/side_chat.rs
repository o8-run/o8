use super::*;
use serde_json::json;

#[derive(Default)]
struct Starts {
    pending: std::collections::HashSet<String>,
    failed: std::collections::HashSet<String>,
}

pub(super) fn start(s: &mut Shell, cx: &mut Context<Shell>) -> Option<String> {
    let workspace = s.state.selected.clone()?;
    if let Some(id) = s.state.right_panel.side_chats.get(&workspace) {
        return Some(id.clone());
    }
    let id = format!(
        "thoughts-side-chat-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    // Main New chat may reuse empty thoughts-next threads; this is its own conversation.
    s.state
        .right_panel
        .side_chats
        .insert(workspace.clone(), id.clone());
    s.features.get::<Starts>().pending.insert(id.clone());
    s.persist();
    let client = s.client.in_workspace(&workspace);
    let target = id.clone();
    let task = cx.background_executor().spawn(async move {
        let defaults: serde_json::Value =
            client.get("/api/panel/operator-defaults", &[("include", "values")])?;
        let mut body =
            json!({"tabId":target,"messages":[],"repoPath":workspace,"title":"Side chat"});
        if let Some(backend) = defaults["values"]["orchestratorBackend"]
            .as_str()
            .filter(|value| *value != "auto")
        {
            body["backend"] = json!(backend);
        }
        if let Some(model) = defaults["values"]["orchestratorModel"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            body["model"] = json!(model);
        }
        let url = client
            .url("/api/v2/chat-history")
            .map_err(|error| error.to_string())?;
        client
            .request("POST", &url)
            .send_json(body)
            .map_err(|error| error.to_string())?;
        client.sessions()
    });
    let started = id.clone();
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |s, cx| {
            s.features.get::<Starts>().pending.remove(&started);
            match result {
                Ok(sessions) => s.sessions = sessions,
                Err(_) => {
                    s.features.get::<Starts>().failed.insert(started);
                }
            }
            cx.notify();
        });
    })
    .detach();
    Some(id)
}
fn failed(s: &Shell, cx: &App) -> bool {
    let Some(id) = s
        .state
        .selected
        .as_ref()
        .and_then(|ws| s.state.right_panel.side_chats.get(ws))
    else {
        return true;
    };
    let _ = cx;
    s.features
        .read::<Starts>()
        .is_some_and(|state| state.failed.contains(id))
}
pub(super) fn ensure(s: &mut Shell, w: &mut Window, cx: &mut Context<Shell>) {
    let Some(p) = s.features.read::<Panel>() else {
        return;
    };
    if !p.motion.is_open() || !(p.selected == Tool::SideChat || p.lower == Some(Tool::SideChat)) {
        return;
    }
    let key = key(s, Tool::SideChat);
    if s.content.contains_key(&key) {
        return;
    }
    let ws = s.state.selected.clone().unwrap_or_default();
    let Some(id) = s.state.right_panel.side_chats.get(&ws).cloned() else {
        return;
    };
    let Some(session) = s.sessions.iter().find(|session| session.id == id).cloned() else {
        if s.connected
            && !s.features.get::<Starts>().pending.contains(&id)
            && s.features.get::<Starts>().failed.insert(id)
        {
            cx.notify();
        }
        return;
    };
    let client = s.client.in_workspace(&ws);
    let view = cx.new(|cx| {
        let mut view = crate::ui::Surface::shell_new(client, vec![session], id.clone(), w, cx);
        view.shell_bind_thread(id);
        view
    });
    view.read(cx).shell_focus(true, w, cx);
    s.content.insert(key, Content::Session(view));
    cx.notify();
}
pub(super) fn element(s: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let key = key(s, Tool::SideChat);
    let content = if let Some(content) = s.content.get(&key) {
        div()
            .size_full()
            .child(content.element())
            .into_any_element()
    } else {
        let failed = failed(s, cx);
        div()
            .p(px(14.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .text_size(px(12.))
            .text_color(theme().text_muted)
            .child(if failed {
                "Could not start side chat. Retry to prepare its separate conversation."
            } else {
                "Preparing a conversation for this repository…"
            })
            .when(failed, |body| {
                body.child(
                    chrome::button(s, "side-chat-retry", "Retry side chat", cx, |s, w, cx| {
                        if let Some(ws) = s.state.selected.clone() {
                            s.state.right_panel.side_chats.remove(&ws);
                        }
                        start(s, cx);
                        show(s, Tool::SideChat, w, cx);
                    })
                    .px(px(8.))
                    .py(px(5.))
                    .child("Retry side chat"),
                )
            })
            .into_any_element()
    };
    div().debug_selector(|| "side-chat-surface".into()).size_full().min_w_0().flex().flex_col().bg(theme().background)
        .child(div().debug_selector(|| "side-chat-intro".into()).flex_shrink_0().px(px(14.)).py(px(12.)).border_b_1().border_color(theme().border)
            .child(div().text_size(px(12.)).text_color(theme().text).child("Side chat"))
            .child(div().mt(px(4.)).text_size(px(11.)).text_color(theme().text_muted).child("A separate conversation with its own messages. Your main conversation stays in place.")))
        .child(div().flex_1().min_h_0().child(content)).into_any_element()
}
