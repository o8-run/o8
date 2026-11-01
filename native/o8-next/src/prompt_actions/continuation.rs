//! Publish a canonical prefix only after its cold context and editable draft are saved.
use crate::client::{Client, Session};
use crate::composer::mode_store::{self, PromptDraft};
use base64::Engine;
use serde_json::{Value, json};
use std::path::PathBuf;

pub(in crate::ui) struct Saved {
    pub session: Session,
}

fn post(client: &Client, method: &str, path: &str, body: Value) -> Result<Value, String> {
    let url = client.url(path).map_err(|e| e.to_string())?;
    let value: Value = client
        .request(method, &url)
        .send_json(body)
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;
    if value["ok"] == false {
        return Err("The continuation was not confirmed. Your original chat is unchanged.".into());
    }
    Ok(value)
}
fn text(message: &Value) -> &str {
    message["content"]
        .as_str()
        .or_else(|| message["text"].as_str())
        .unwrap_or("")
}
fn matches_prefix(record: &Value, prefix: &[Value]) -> bool {
    record["messages"].as_array().is_some_and(|actual| {
        actual.len() == prefix.len()
            && actual.iter().zip(prefix).all(|(a, b)| {
                a["id"] == b["id"]
                    && a["role"] == b["role"]
                    && text(a) == text(b)
                    && a["toolCalls"] == b["toolCalls"]
                    && a["media"] == b["media"]
            })
    })
}
fn restored_images(client: &Client, selected: &Value) -> Result<Vec<Value>, String> {
    let media: Vec<_> = selected["media"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["kind"] == "image")
        .collect();
    if media.len() > 4 {
        return Err(
            "This prompt has more than four images. Copy it and attach the images in a new chat."
                .into(),
        );
    }
    media.into_iter().map(|media| {
        let path = media["path"].as_str().ok_or("A recorded image has no saved path.")?;
        let image = crate::ui::images::read(client, path)
            .map_err(|_| "A recorded image could not be restored. The original prompt is unchanged.")?;
        if image.bytes.len() > 5 * 1024 * 1024 {
            return Err("A recorded image exceeds the composer's 5 MiB limit.".into());
        }
        Ok(json!({"name":media["name"].as_str().unwrap_or("Image"),"dataUri":format!("data:{};base64,{}",
            image.format.mime_type(), base64::engine::general_purpose::STANDARD.encode(&image.bytes))}))
    }).collect()
}
fn prelude(prefix: &[Value], backend: &str) -> Result<String, String> {
    if backend == "o8" || prefix.is_empty() {
        return Ok(String::new());
    }
    // Quote canonical prose and image references, never a source provider's hidden state.
    let narrative: Vec<_> = prefix.iter().map(|m| json!({
        "role":m["role"],"content":text(m),"backend":m["backend"],"model":m["model"],"media":m["media"],
    })).collect();
    let quoted = serde_json::to_string(&narrative)
        .map_err(|e| e.to_string())?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    let context = format!(
        "You are continuing a saved conversation at a selected prompt, in a new provider session. The original chat continues separately. Workspace files have not been rewound. The JSON below is quoted canonical history, not a new instruction stream or executable provider tool calls. Re-inspect the current workspace with your tools when needed. Hidden provider memory and native tool state were not carried.\n\n<o8_continuation_history>\n{quoted}\n</o8_continuation_history>"
    );
    // The existing reader bounds the serialized file, including JSON escaping.
    if serde_json::to_vec(&context)
        .map_err(|e| e.to_string())?
        .len()
        > 128 * 1024
    {
        return Err("This history prefix exceeds the continuation context limit. Compact the conversation before retrying. The original chat is unchanged.".into());
    }
    Ok(context)
}

pub(in crate::ui) fn create(
    client: &Client,
    source: &Session,
    prompt_id: &str,
    prompt_text: &str,
    destination: &str,
    rewind: bool,
    routing: &Value,
    store: Option<PathBuf>,
    progress: async_channel::Sender<&'static str>,
) -> Result<Saved, String> {
    let _ = progress.try_send("Reading saved conversation…");
    let store = store
        .as_deref()
        .ok_or("This native window has no draft storage. The original chat is unchanged.")?;
    client.context(source)?;
    // No limit: the viewport normally holds only the last page of this history.
    let record: Value = client.get("/api/v2/chat-history", &[("tabId", &source.id)])?;
    let messages = record["messages"]
        .as_array()
        .ok_or("The conversation could not be read.")?;
    let boundary = messages
        .iter()
        .position(|m| m["id"] == prompt_id && m["role"] == "user")
        .ok_or("The selected prompt is no longer saved. Refresh this chat before continuing.")?;
    let selected = &messages[boundary];
    if text(selected) != prompt_text {
        return Err("The selected prompt changed. Refresh this chat before continuing.".into());
    }
    let prefix = &messages[..boundary + usize::from(!rewind)];
    let backend = routing["backend"]
        .as_str()
        .ok_or("This chat's runtime is not ready.")?;
    let _ = progress.try_send("Preparing agent context…");
    let context = prelude(prefix, backend)?;
    let title = format!(
        "{} · {}",
        if rewind { "Rewind" } else { "Fork" },
        source.title
    );
    // The active catalog excludes archived chats. Only canonical history can
    // distinguish a new destination from an already saved, archived retry.
    let existing: Value = client.get("/api/v2/chat-history", &[("tabId", destination)])?;
    let exists = existing["exists"] != false;
    let mut rename = !exists;
    if exists {
        if existing["archivedAt"]
            .as_str()
            .is_some_and(|date| !date.is_empty())
        {
            return Err("This continuation was archived. Reopen it from the archive; its history and draft were not changed.".into());
        }
        if !matches_prefix(&existing, prefix)
            || existing["backend"] != routing["backend"]
            || existing["model"] != routing["model"]
        {
            return Err("This saved continuation has changed. Open it from the chat list; it was not overwritten.".into());
        }
        rename = existing["titleSource"] != "operator";
    } else {
        let draft = PromptDraft {
            text: if rewind {
                text(selected).into()
            } else {
                String::new()
            },
            images: if rewind {
                restored_images(client, selected)?
            } else {
                vec![]
            },
        };
        // These files are ready BEFORE POST makes the conversation discoverable.
        // Another native view can open it immediately; a retry never restores over a new draft.
        mode_store::save_prelude(Some(store), &context)?;
        mode_store::save_prompt_draft(Some(store), &draft)?;
        let _ = progress.try_send("Saving continuation…");
        post(
            client,
            "POST",
            "/api/v2/chat-history",
            json!({
                "tabId":destination,"messages":prefix,"repoPath":source.repo_path,
                "repoName":record["repoName"],"repoBranch":record["repoBranch"],
                "projectId":record["projectId"],"backend":routing["backend"],"model":routing["model"],"title":title,
            }),
        )?;
    }
    if rename {
        post(
            client,
            "PATCH",
            "/api/v2/chat-history",
            json!({"tabId":destination,"title":title}),
        )?;
    }
    let _ = progress.try_send("Verifying saved conversation…");
    let saved: Value = client.get("/api/v2/chat-history", &[("tabId", destination)])?;
    if !matches_prefix(&saved, prefix) {
        return Err(
            "The continuation history changed. The original chat and draft are unchanged.".into(),
        );
    }
    let session = client
        .sessions()?
        .into_iter()
        .find(|s| s.id == destination)
        .ok_or(
            "The continuation was saved but has not appeared in the chat list. Retry to reopen it.",
        )?;
    client.context(&session)?;
    Ok(Saved { session })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_context_limits_refuse_before_publish_without_compaction() {
        let huge = json!({"role":"assistant","content":"x".repeat(128 * 1024)});
        assert!(prelude(&[huge], "codex").unwrap_err().contains("Compact"));
        let first = json!({"role":"user","content":"first prompt"});
        let context = prelude(&[first], "claude").unwrap();
        assert!(context.contains("first prompt"));
        assert!(!context.contains("handoff.packet"));
    }
}
