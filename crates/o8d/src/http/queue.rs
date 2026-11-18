//! Ordinary composer list reads. Node validates the target and supplies live
//! capabilities per request; visual/network receipts and all writers stay TS.
use super::*;
const MAX_SAFE: i64 = 9_007_199_254_740_991;
fn integer(row: &rusqlite::Row<'_>, index: usize) -> Result<i64, ()> {
    row.get::<_, i64>(index).map_err(|_| ()).and_then(|n| {
        if (-MAX_SAFE..=MAX_SAFE).contains(&n) {
            Ok(n)
        } else {
            Err(())
        }
    })
}
fn optional_integer(row: &rusqlite::Row<'_>, index: usize) -> Result<Value, ()> {
    if matches!(
        row.get_ref(index).map_err(|_| ())?,
        rusqlite::types::ValueRef::Null
    ) {
        Ok(Value::Null)
    } else {
        integer(row, index).map(|n| json!(n))
    }
}
fn capability(payload: &Value) -> Result<&str, ()> {
    let route = &payload["routing"];
    let backend = route["backend"].as_str().ok_or(())?;
    let mode = route["mode"].as_str().ok_or(())?;
    let collide = route["collide"].as_bool().ok_or(())?;
    Ok(if collide && mode != "single" {
        "collide"
    } else {
        backend
    })
}
fn images(payload: &Value) -> Result<Vec<Value>, ()> {
    let Some(media) = payload.get("deliveredMedia").filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    media
        .as_array()
        .ok_or(())?
        .iter()
        .map(|media| {
            if !media.is_object() {
                return Err(());
            }
            let name = media
                .get("name")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!("Image"));
            if !name.is_string() {
                return Err(());
            }
            let mut image = json!({"name":name});
            if let Some(path) = media.get("path") {
                if !path.is_string() && !path.is_null() {
                    return Err(());
                }
                image["dataUri"] = path.clone();
            }
            Ok(image)
        })
        .collect()
}
pub(super) fn read(store: &ReadContext<'_>, params: &Params) -> Response {
    let result = (|| -> Result<Value, ()> {
        if params.contains_key("id") {
            return Err(());
        }
        let context = store.defaults_context.as_ref().ok_or(())?;
        let grant = composer_queue_grant::parse(&context["composerQueue"])?;
        if params.get("repoPath") != Some(&grant.request_repo)
            || params.get("threadId") != Some(&grant.thread)
            || params.get("backend") != grant.backend.as_ref()
        {
            return Err(());
        }
        let db = store.database()?;
        let unsupported: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM composer_send_queue WHERE repo_path = ? AND thread_id = ? AND (status IS NULL OR status NOT IN ('queued','dispatching','applied','held','cancelled')))",[&grant.repo,&grant.thread],|r| r.get(0)).map_err(|_| ())?;
        if unsupported {
            return Err(());
        }
        let history = chat_context::read(store, &grant.thread)?;
        if !history.is_object() || history["source"] == "bot-network" {
            return Err(());
        }
        let messages = history["messages"].as_array().ok_or(())?;
        if messages.iter().any(|m| !m.is_object()) {
            return Err(());
        }
        let mut query = db.prepare("SELECT sequence,id,repo_path,thread_id,intent,payload_json,status,reason,created_at,updated_at,admitted_at FROM composer_send_queue WHERE repo_path = ? AND thread_id = ? AND (status IN ('queued','dispatching','held') OR sequence IN (SELECT sequence FROM composer_send_queue WHERE repo_path = ? AND thread_id = ? AND intent = 'steer-now' AND status = 'applied' ORDER BY sequence DESC LIMIT 40)) ORDER BY sequence").map_err(|_| ())?;
        let mut rows = query
            .query([&grant.repo, &grant.thread, &grant.repo, &grant.thread])
            .map_err(|_| ())?;
        let mut items = Vec::new();
        let mut steerable = Vec::new();
        let mut budget = 0usize;
        while let Some(row) = rows.next().map_err(|_| ())? {
            let raw: String = row.get(5).map_err(|_| ())?;
            budget = budget.checked_add(raw.len()).ok_or(())?;
            if budget > RESPONSE_LIMIT {
                return Err(());
            }
            let mut payload: Value = serde_json::from_str(&raw).map_err(|_| ())?;
            if !payload.is_object() {
                return Err(());
            }
            let effective = capability(&payload)?;
            let capable = grant.capabilities.get(effective).copied().unwrap_or(false);
            let id: String = row.get(1).map_err(|_| ())?;
            let intent: String = row.get(4).map_err(|_| ())?;
            let status: String = row.get(6).map_err(|_| ())?;
            if !["send-next", "steer-now"].contains(&intent.as_str())
                || !["queued", "dispatching", "held", "applied"].contains(&status.as_str())
            {
                return Err(());
            }
            let message_id = format!("composer-steer-{id}");
            let message = messages
                .iter()
                .find(|m| m["id"].as_str() == Some(message_id.as_str()));
            // TS computes delivered media for every selected row, then only
            // replaces payload text/images for applied steer receipts.
            let images = images(&payload)?;
            if status == "applied" {
                payload["text"] = message
                    .and_then(|m| m.get("content"))
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or_else(|| json!(""));
                payload["images"] = json!(images);
            }
            let mut item = json!({"sequence":integer(row,0)?,"id":id,"repoPath":row.get::<_,String>(2).map_err(|_| ())?,"threadId":row.get::<_,String>(3).map_err(|_| ())?,"intent":intent,"payload":payload,"status":status,"reason":row.get::<_,Option<String>>(7).map_err(|_| ())?,"createdAt":integer(row,8)?,"updatedAt":integer(row,9)?,"admittedAt":optional_integer(row,10)?});
            if let Some(anchor) = message.and_then(|m| m.get("steerAnchor")) {
                item["steerAnchor"] = anchor.clone();
            }
            if capable {
                steerable.push(id);
            }
            items.push(item);
        }
        let can_steer = match grant.backend {
            Some(id) => grant.capabilities.get(&id).copied().unwrap_or(false),
            None => false,
        };
        Ok(json!({"items":items,"canSteer":can_steer,"steerableIds":steerable}))
    })();
    match result {
        Ok(body) => {
            let mut response = chat_context::respond(StatusCode::OK, body);
            response.headers_mut().insert(
                "cache-control",
                axum::http::HeaderValue::from_static("no-store"),
            );
            response
        }
        Err(()) => unavailable(),
    }
}
