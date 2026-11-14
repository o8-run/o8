//! A delegate without a saved turn still has a transcript state, not a text view.
use super::*;
use crate::model::{Entry, History};

pub(super) fn fallback(agent: &Agent, key: String) -> History {
    let entry = |id: &str, role: &str, text: &str| Entry {
        id: format!("{}:{id}", agent.id),
        role: role.into(),
        text: text.into(),
        tools: None,
        extra: Default::default(),
    };
    let mut transcript = Vec::new();
    if let Some(prompt) = &agent.prompt {
        transcript.push(entry("prompt", "user", prompt));
    }
    if let Some(result) = &agent.result {
        transcript.push(entry("result", "assistant", result));
    }
    if agent.group != model::Group::Working {
        if let Some(last) = transcript.last_mut() {
            last.extra
                .insert("receipt".into(), serde_json::json!({"terminal":{}}));
        }
    }
    // The same terminal-note representation used by main chat on a failed turn.
    if agent.group == model::Group::Attention {
        let mut note = entry("state", "assistant", "");
        note.extra.insert(
            "terminalNote".into(),
            serde_json::json!({"text":agent.status,"attention":true}),
        );
        note.extra
            .insert("receipt".into(), serde_json::json!({"terminal":{}}));
        transcript.push(note);
        // A long failure reason wraps as the chat's system message, rather
        // than being squeezed into the trace's single-line status header.
        if let Some(reason) = agent
            .progress
            .as_ref()
            .filter(|reason| !reason.trim().is_empty())
        {
            transcript.push(entry("reason", "system", reason));
        }
    }
    History {
        session_key: key,
        transcript,
        page: None,
    }
}
