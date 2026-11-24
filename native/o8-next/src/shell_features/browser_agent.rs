use super::*;
use serde_json::json;
struct BrowserAgent;
register_shell_feature!(BrowserAgent);
impl ShellFeature for BrowserAgent {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 55,
            run: |s, _, window, cx| {
                #[cfg(unix)]
                while let Some(path) = crate::app_parent::take_document() {
                    if !path.is_dir() {
                        super::right_panel::open_document(s, path, window, cx);
                        continue;
                    }
                    // An opened folder becomes the active project once the
                    // sidebar exists; until then it waits in the queue.
                    let (Some(list), Some(folder)) = (
                        s.surfaces.sidebar.view.clone(),
                        path.to_str().map(str::to_owned),
                    ) else {
                        if s.surfaces.sidebar.view.is_none() {
                            crate::app_parent::defer_document(path);
                            break;
                        }
                        continue;
                    };
                    list.update(cx, |list, cx| list.open_folder(folder, cx));
                }
                if let Some(id) = s.surfaces.sidebar.focus_composer_for.clone()
                    && s.active() == Some(Tab::Session(id))
                    && s.active()
                        .is_some_and(|tab| s.content.contains_key(&s.key(&tab)))
                {
                    s.surfaces.sidebar.focus_composer_for = None;
                    let selected = s.state.selected.clone().unwrap_or_default();
                    if let Some(saved) = s.state.workspaces.get_mut(&selected) {
                        saved.composer = true;
                    }
                    s.restore_focus(window, cx);
                }
                // Bounded parent queue, each mutation is removed before dispatch.
                while let Some(frame) = crate::app_parent::take_browser_request() {
                    let id = frame["id"].as_str().unwrap_or_default().to_string();
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    if frame["expiresAt"].as_u64().unwrap_or(0) < now {
                        crate::app_parent::browser_result(
                            &id,
                            json!({"ok":false,"error":"Browser action expired","actionDispatched":false}),
                        );
                        continue;
                    }
                    let Some(view) = super::right_panel::active_browser(s) else {
                        crate::app_parent::browser_result(
                            &id,
                            json!({"ok":false,"error":"Open the Browser panel first"}),
                        );
                        continue;
                    };
                    view.update(cx, |browser, cx| {
                        browser.agent(
                            frame["verb"].as_str().unwrap_or_default(),
                            &frame["args"],
                            move |result| crate::app_parent::browser_result(&id, result),
                            cx,
                        )
                    });
                }
            },
        }]
    }
}
