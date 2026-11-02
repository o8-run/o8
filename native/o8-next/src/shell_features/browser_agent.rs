use super::*;
use serde_json::json;
struct BrowserAgent;
register_shell_feature!(BrowserAgent);
impl ShellFeature for BrowserAgent {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 55,
            run: |s, _, _, cx| {
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
