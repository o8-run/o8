//! Bounded occupancy only. Ordinary lane reconciliation retains its TS owner.
use super::{reply, unavailable, Params, ReadContext};
use axum::{http::{HeaderValue, StatusCode}, response::Response};
use serde_json::json;

pub(super) fn read(store: &ReadContext<'_>, params: &Params) -> Response {
    let read = || -> Result<_, ()> {
        if params.get("view").map(String::as_str) != Some("live")
            || store.defaults_context.as_ref().and_then(|v| v["laneLive"].as_bool()) != Some(true)
        {
            return Err(());
        }
        let db = store.database()?;
        let mut query = db.prepare("SELECT id, packet_id, status, worktree_path FROM lanes WHERE status != 'archived' AND status != 'completed' ORDER BY created_at ASC LIMIT 10001").map_err(|_| ())?;
        let rows = query.query_map([], |row| Ok(json!({
            "id": row.get::<_, String>(0)?,
            "packetId": row.get::<_, Option<String>>(1)?,
            "status": row.get::<_, String>(2)?,
            "worktreePath": row.get::<_, Option<String>>(3)?,
        }))).map_err(|_| ())?.collect::<Result<Vec<_>, _>>().map_err(|_| ())?;
        if rows.len() > 10000 { return Err(()); }
        Ok(json!({ "lanes": rows }))
    };
    match read() {
        Ok(body) => {
            let mut response = reply(StatusCode::OK, body);
            response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store, max-age=0"));
            response
        }
        Err(()) => unavailable(),
    }
}
