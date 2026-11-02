//! Classic's page agent, evaluated only by the host into its active WKWebView.
use super::*;
use serde_json::{Value, json};

pub(super) fn script(verb: &str, args: &Value) -> Option<String> {
    if !matches!(
        verb,
        "read" | "localize" | "rect" | "click" | "type" | "probe" | "grab"
    ) {
        return None;
    }
    Some(format!(
        "{}\n(function(){{try{{return JSON.stringify(window.__o8BrowserAgent.{}({}));}}catch(e){{return JSON.stringify({{ok:false,error:String(e.message||e)}});}}}})()",
        include_str!("agent.js"),
        verb,
        args
    ))
}
impl BrowserPanel {
    pub(crate) fn agent(
        &mut self,
        verb: &str,
        args: &Value,
        done: impl Fn(Value) + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(script) = script(verb, args) else {
            done(json!({"ok":false,"error":"Unsupported Browser verb"}));
            return;
        };
        if self.covered {
            done(json!({"ok":false,"error":"Browser panel is covered"}));
            return;
        }
        let Some(page) = self.active.and_then(|id| self.pages.get(&id)) else {
            done(json!({"ok":false,"error":"No active Browser page"}));
            return;
        };
        let slot = page.web.borrow();
        let Some(web) = slot.as_ref().filter(|web| web.has_document()) else {
            done(json!({"ok":false,"error":"Browser page is not ready"}));
            return;
        };
        web.evaluate(&script, done);
        self.agent_glow = Some(Instant::now());
        cx.notify();
    }
}
