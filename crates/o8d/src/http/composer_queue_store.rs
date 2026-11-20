//! Durable composer admission on the existing ledger. No executor lives here.
//! Callers validate authorization, target and payload before entering this store.
use base64::Engine;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub(crate) enum Error {
    Database(rusqlite::Error),
    InvalidPayload,
    IdentityConflict,
    QueueFull,
    FollowupExists,
    NotFound,
    NotSteerable,
}
impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value)
    }
}
pub(crate) struct Admission<'a> {
    pub id: &'a str,
    pub repo_path: &'a str,
    pub thread_id: &'a str,
    pub intent: &'a str,
    /// Validated serialized bytes, retained without a JSON round trip.
    pub payload_json: &'a str,
    pub ingress: Option<&'a Ingress<'a>>,
}
pub(crate) struct Ingress<'a> {
    /// Image-free wire sidecar constructed by the ingress codec.
    pub json: &'a str,
    /// Hash of full original wire bytes, before image removal.
    pub hash: &'a str,
}
pub(crate) struct Change {
    pub item: Value,
    pub changed: bool,
}
pub(crate) struct Target<'a> {
    pub repo_path: &'a str,
    pub thread_id: &'a str,
}
pub(crate) struct Claim {
    pub item: Value,
    pub token: String,
    pub ingress: Option<Value>,
}
fn claimed(db: &Connection, id: &str, token: &str) -> Result<Option<Claim>, Error> {
    let Some(item) = read(db, id)? else {
        return Ok(None);
    };
    let sidecar: Option<String> = db.query_row(
        "SELECT ingress_json FROM composer_send_queue WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    let ingress = sidecar
        .map(|raw| {
            super::composer_queue_ingress::rebuild(&raw, &item["payload"]["images"])
                .map_err(|_| Error::InvalidPayload)
        })
        .transpose()?;
    Ok(Some(Claim {
        item,
        token: token.into(),
        ingress,
    }))
}
pub(crate) fn list(db: &Connection, target: &Target<'_>) -> Result<Vec<Value>, Error> {
    Ok(db.prepare(&format!("SELECT {COLUMNS} FROM composer_send_queue WHERE repo_path=?1 AND thread_id=?2 AND thread_id NOT LIKE 'wsi:%' AND status IN ('queued','dispatching','held') ORDER BY sequence"))?
        .query_map([target.repo_path,target.thread_id],item)?.collect::<Result<_,_>>()?)
}
pub(crate) fn peek(db: &Connection, target: &Target<'_>) -> Result<Option<Value>, Error> {
    let mut held_at = i64::MIN;
    for item in list(db, target)? {
        let id = item["id"].as_str().ok_or(Error::InvalidPayload)?;
        let ingress: bool = db.query_row(
            "SELECT ingress_hash IS NOT NULL FROM composer_send_queue WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        if ingress {
            continue;
        }
        if item["status"] == "held" {
            held_at = held_at.max(item["updatedAt"].as_i64().ok_or(Error::InvalidPayload)?);
        } else {
            return Ok(
                (held_at < item["createdAt"].as_i64().ok_or(Error::InvalidPayload)?)
                    .then_some(item),
            );
        }
    }
    Ok(None)
}
/// Exactly the legacy claim order: held fences first, then one queued send-next.
pub(crate) fn claim(
    db: &mut Connection,
    target: &Target<'_>,
    now: i64,
) -> Result<Option<Claim>, Error> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(first) = peek(&tx, target)? else {
        tx.commit()?;
        return Ok(None);
    };
    if first["status"] != "queued" || first["intent"] != "send-next" {
        tx.commit()?;
        return Ok(None);
    }
    let id = first["id"].as_str().ok_or(Error::InvalidPayload)?;
    let token =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes());
    let changed = tx.execute("UPDATE composer_send_queue SET status='dispatching',updated_at=?1,claim_token=?3 WHERE id=?2 AND status='queued' AND intent='send-next'",rusqlite::params![now,id,token])?;
    let answer = if changed == 1 {
        claimed(&tx, id, &token)?
    } else {
        None
    };
    tx.commit()?;
    Ok(answer)
}
pub(crate) fn admit(db: &Connection, id: &str, token: &str, now: i64) -> Result<bool, Error> {
    Ok(db.execute("UPDATE composer_send_queue SET admitted_at=?1,updated_at=?1 WHERE id=?2 AND status='dispatching' AND admitted_at IS NULL AND claim_token=?3",rusqlite::params![now,id,token])? == 1)
}
pub(crate) fn claim_ingress(
    db: &mut Connection,
    id: &str,
    now: i64,
) -> Result<Option<Claim>, Error> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let token =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes());
    let changed=tx.execute("UPDATE composer_send_queue SET status='dispatching',updated_at=?1,claim_token=?2 WHERE id=?3 AND status='queued' AND ingress_json IS NOT NULL",rusqlite::params![now,token,id])?;
    let answer = if changed == 1 {
        claimed(&tx, id, &token)?
    } else {
        None
    };
    tx.commit()?;
    Ok(answer)
}
pub(crate) fn claim_steer(db: &mut Connection, id: &str, now: i64) -> Result<Option<Claim>, Error> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let token =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes());
    let changed=tx.execute("UPDATE composer_send_queue SET status='dispatching',updated_at=?1,claim_token=?2 WHERE id=?3 AND status='queued' AND intent='steer-now' AND admitted_at IS NULL",rusqlite::params![now,token,id])?;
    let answer = if changed == 1 {
        claimed(&tx, id, &token)?
    } else {
        None
    };
    tx.commit()?;
    Ok(answer)
}
pub(crate) fn list_all(db: &Connection) -> Result<Vec<Value>, Error> {
    Ok(db.prepare(&format!("SELECT {COLUMNS} FROM composer_send_queue WHERE thread_id NOT LIKE 'wsi:%' AND status IN ('queued','dispatching','held') ORDER BY sequence"))?.query_map([],item)?.collect::<Result<_,_>>()?)
}
pub(crate) fn transcript(db: &Connection, repo: &str, thread: &str) -> Result<Vec<Value>, Error> {
    Ok(db.prepare(&format!("SELECT {COLUMNS} FROM composer_send_queue WHERE repo_path=?1 AND thread_id=?2 AND thread_id NOT LIKE 'wsi:%' AND (status IN ('queued','dispatching','held') OR sequence IN (SELECT sequence FROM composer_send_queue WHERE repo_path=?1 AND thread_id=?2 AND intent='steer-now' AND status='applied' ORDER BY sequence DESC LIMIT 40)) ORDER BY sequence"))?.query_map([repo,thread],item)?.collect::<Result<_,_>>()?)
}
pub(crate) fn targets(db: &Connection) -> Result<Vec<Value>, Error> {
    Ok(db.prepare("SELECT repo_path,thread_id FROM composer_send_queue WHERE thread_id NOT LIKE 'wsi:%' AND status IN ('queued','dispatching','held') GROUP BY repo_path,thread_id ORDER BY MIN(sequence)")?.query_map([],|r|Ok(json!({"repoPath":r.get::<_,String>(0)?,"threadId":r.get::<_,String>(1)?})))?.collect::<Result<_,_>>()?)
}
pub(crate) fn promote(
    db: &mut Connection,
    target: &Target<'_>,
    id: &str,
    now: i64,
) -> Result<Change, Error> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = read(&tx, id)?.ok_or(Error::NotFound)?;
    if existing["repoPath"] != target.repo_path || existing["threadId"] != target.thread_id {
        return Err(Error::NotFound);
    }
    if existing["intent"] == "steer-now" {
        tx.commit()?;
        return Ok(Change {
            item: existing,
            changed: false,
        });
    }
    if existing["status"] != "queued"
        || !existing["admittedAt"].is_null()
        || existing["payload"]
            .get("afterTaskId")
            .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    {
        return Err(Error::NotSteerable);
    }
    tx.execute(
        "UPDATE composer_send_queue SET intent='steer-now',updated_at=?1 WHERE id=?2",
        rusqlite::params![now, id],
    )?;
    let item = read(&tx, id)?.ok_or(Error::NotFound)?;
    tx.commit()?;
    Ok(Change {
        item,
        changed: true,
    })
}
pub(crate) fn cancel(
    db: &mut Connection,
    target: &Target<'_>,
    id: &str,
    now: i64,
    compact: impl FnOnce(&str, bool) -> Result<String, Error>,
) -> Result<bool, Error> {
    removing_payload(db, |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed=tx.execute("UPDATE composer_send_queue SET status='cancelled',reason='Removed by operator.',updated_at=?1,claim_token=NULL,ingress_json=NULL WHERE id=?2 AND repo_path=?3 AND thread_id=?4 AND (status IN ('queued','held') OR (status='dispatching' AND admitted_at IS NULL))",rusqlite::params![now,id,target.repo_path,target.thread_id])?==1;
        if changed {
            compact_row(&tx, id, now, compact)?;
        }
        tx.commit()?;
        Ok(changed)
    })
}
pub(crate) fn hold(
    db: &mut Connection,
    target: &Target<'_>,
    now: i64,
    mut compact: impl FnMut(&str, bool) -> Result<String, Error>,
) -> Result<bool, Error> {
    removing_payload(db, |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let delivered:Vec<String>=tx.prepare("SELECT id FROM composer_send_queue WHERE repo_path=?1 AND thread_id=?2 AND status='dispatching' AND admitted_at IS NOT NULL")?.query_map([target.repo_path,target.thread_id],|r|r.get(0))?.collect::<Result<_,_>>()?;
        for id in &delivered {
            tx.execute("UPDATE composer_send_queue SET status='applied',reason='Chat stopped.',updated_at=?1,claim_token=NULL,ingress_json=NULL WHERE id=?2 AND status='dispatching' AND admitted_at IS NOT NULL",rusqlite::params![now,id])?;
            compact_row(&tx, id, now, &mut compact)?;
        }
        let held=tx.execute("UPDATE composer_send_queue SET status='held',reason='Chat stopped.',updated_at=?1,claim_token=NULL WHERE repo_path=?2 AND thread_id=?3 AND status IN ('queued','dispatching')",rusqlite::params![now,target.repo_path,target.thread_id])?;
        tx.commit()?;
        Ok(!delivered.is_empty() || held > 0)
    })
}
pub(crate) fn assert_claim(db: &Connection, id: &str, token: &str) -> Result<bool, Error> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM composer_send_queue WHERE id=?1 AND status='dispatching' AND claim_token=?2)",[id,token],|r|r.get(0))?)
}
pub(crate) fn defer_steer(
    db: &Connection,
    id: &str,
    token: &str,
    reason: &str,
    now: i64,
) -> Result<bool, Error> {
    Ok(db.execute("UPDATE composer_send_queue SET intent='send-next',status='queued',admitted_at=NULL,reason=?1,updated_at=?2,claim_token=NULL WHERE id=?3 AND status='dispatching' AND claim_token=?4",rusqlite::params![reason,now,id,token])?==1)
}
/// The compactor runs inside this transaction, preserving legacy payload/media
/// lifecycle and rollback. Sidecar removal never leaves a duplicate wire body.
pub(crate) fn settle(
    db: &mut Connection,
    id: &str,
    token: &str,
    status: &str,
    reason: Option<&str>,
    now: i64,
    compact: impl FnOnce(&str, bool) -> Result<String, Error>,
) -> Result<bool, Error> {
    if status == "applied" {
        return removing_payload(db, |db| {
            settle_inner(db, id, token, status, reason, now, compact)
        });
    }
    settle_inner(db, id, token, status, reason, now, compact)
}
pub(super) fn removing_payload<T>(
    db: &mut Connection,
    write: impl FnOnce(&mut Connection) -> Result<T, Error>,
) -> Result<T, Error> {
    let previous: i64 = db.pragma_query_value(None, "secure_delete", |row| row.get(0))?;
    db.pragma_update(None, "secure_delete", "ON")?;
    let answer = write(db);
    // A policy-restoration failure cannot change an already committed outcome.
    if db.pragma_update(None, "secure_delete", previous).is_err() {
        eprintln!("o8d: composer secure-delete policy restore failed");
    }
    answer
}
fn settle_inner(
    db: &mut Connection,
    id: &str,
    token: &str,
    status: &str,
    reason: Option<&str>,
    now: i64,
    compact: impl FnOnce(&str, bool) -> Result<String, Error>,
) -> Result<bool, Error> {
    if !matches!(status, "applied" | "held") {
        return Err(Error::InvalidPayload);
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed=tx.execute("UPDATE composer_send_queue SET status=?1,reason=?2,updated_at=?3,claim_token=NULL,ingress_json=CASE WHEN ?1='applied' THEN NULL ELSE ingress_json END WHERE id=?4 AND status='dispatching' AND (?1!='applied' OR admitted_at IS NOT NULL) AND claim_token=?5",rusqlite::params![status,reason,now,id,token])?==1;
    if changed && status == "applied" {
        compact_row(&tx, id, now, compact)?;
    }
    tx.commit()?;
    Ok(changed)
}
fn compact_row(
    db: &Connection,
    id: &str,
    now: i64,
    compact: impl FnOnce(&str, bool) -> Result<String, Error>,
) -> Result<(), Error> {
    let (raw, intent, status): (String, String, String) = db.query_row(
        "SELECT payload_json,intent,status FROM composer_send_queue WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let compacted = compact(&raw, status == "applied" && intent == "steer-now")?;
    let hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
    db.execute("UPDATE composer_send_queue SET payload_hash=COALESCE(payload_hash,?1),payload_bytes=COALESCE(payload_bytes,?2),payload_json=?3,payload_compacted_at=?4 WHERE id=?5",rusqlite::params![hash,raw.len() as i64,compacted,now,id])?;
    Ok(())
}
const COLUMNS: &str = "sequence,id,repo_path,thread_id,intent,payload_json,status,reason,created_at,updated_at,admitted_at";
fn item(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let serialized: String = row.get(5)?;
    let payload: Value = serde_json::from_str(&serialized).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(
        json!({"sequence":row.get::<_,i64>(0)?,"id":row.get::<_,String>(1)?,
        "repoPath":row.get::<_,String>(2)?,"threadId":row.get::<_,String>(3)?,
        "intent":row.get::<_,String>(4)?,"payload":payload,"status":row.get::<_,String>(6)?,
        "reason":row.get::<_,Option<String>>(7)?,"createdAt":row.get::<_,i64>(8)?,
        "updatedAt":row.get::<_,i64>(9)?,"admittedAt":row.get::<_,Option<i64>>(10)?}),
    )
}
pub(crate) fn notice_target(db: &Connection, id: &str) -> Result<Option<Value>, Error> {
    Ok(db.query_row("SELECT id,repo_path,thread_id FROM composer_send_queue WHERE id=?1",[id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"repoPath":r.get::<_,String>(1)?,"threadId":r.get::<_,String>(2)?}))).optional()?)
}
pub(crate) fn read(db: &Connection, id: &str) -> Result<Option<Value>, Error> {
    Ok(db
        .query_row(
            &format!("SELECT {COLUMNS} FROM composer_send_queue WHERE id=?1"),
            [id],
            item,
        )
        .optional()?)
}
pub(crate) fn enqueue(
    db: &mut Connection,
    input: Admission<'_>,
    now: i64,
) -> Result<Change, Error> {
    let thread = input.thread_id.to_owned();
    enqueue_resolved(db, input, now, None, || Ok(thread))
}
/// The retry lookup precedes classification within this transaction. A saved
/// history appearing after the first ingress cannot retarget that identity.
pub(crate) fn enqueue_resolved(
    db: &mut Connection,
    input: Admission<'_>,
    now: i64,
    ingress_targets: Option<(Option<&str>, &str)>,
    resolve_thread: impl FnOnce() -> Result<String, Error>,
) -> Result<Change, Error> {
    let payload: Value =
        serde_json::from_str(input.payload_json).map_err(|_| Error::InvalidPayload)?;
    if !payload.is_object() || !matches!(input.intent, "send-next" | "steer-now") {
        return Err(Error::InvalidPayload);
    }
    super::composer_queue_payload::validate_selection(&payload, input.ingress.is_some())
        .map_err(|_| Error::InvalidPayload)?;
    let hash = format!("{:x}", Sha256::digest(input.payload_json.as_bytes()));
    let bytes = input.payload_json.len() as i64;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(mut existing) = read(&tx, input.id)? {
        let (stored_hash, stored_bytes, serialized, ingress_hash): (Option<String>, Option<i64>, String, Option<String>) = tx
            .query_row(
            "SELECT payload_hash,payload_bytes,payload_json,ingress_hash FROM composer_send_queue WHERE id=?1",
            [input.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let stored_hash =
            stored_hash.unwrap_or_else(|| format!("{:x}", Sha256::digest(serialized.as_bytes())));
        let target_matches = if let Some((real, synthetic)) = ingress_targets {
            existing["threadId"] == synthetic || real.is_some_and(|s| existing["threadId"] == s)
        } else {
            existing["threadId"] == input.thread_id
        };
        if existing["repoPath"] != input.repo_path
            || !target_matches
            || input.ingress.is_none()
                && (stored_hash != hash || stored_bytes.is_some_and(|n| n != bytes))
            || ingress_hash.as_deref() != input.ingress.map(|i| i.hash)
        {
            return Err(Error::IdentityConflict);
        }
        // Desktop retries echo the matched submitted payload after compaction.
        // Ingress retries retain the FIRST recorded WS selection (v1.9).
        if input.ingress.is_none() {
            existing["payload"] = payload;
        }
        tx.commit()?;
        return Ok(Change {
            item: existing,
            changed: false,
        });
    }
    let resolved_thread = resolve_thread()?;
    let input = Admission {
        thread_id: &resolved_thread,
        ..input
    };
    let mut count = 0;
    let mut followup_exists = false;
    {
        let mut query=tx.prepare("SELECT payload_json FROM composer_send_queue WHERE repo_path=?1 AND thread_id=?2 AND status IN ('queued','dispatching','held') ORDER BY sequence")?;
        let mut rows = query.query([input.repo_path, input.thread_id])?;
        while let Some(row) = rows.next()? {
            let raw: String = row.get(0)?;
            let saved: Value = serde_json::from_str(&raw).map_err(|_| Error::InvalidPayload)?;
            count += 1;
            followup_exists |= saved
                .get("afterTaskId")
                .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()));
        }
    }
    if payload
        .get("afterTaskId")
        .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        && followup_exists
    {
        return Err(Error::FollowupExists);
    }
    if count >= 20 {
        return Err(Error::QueueFull);
    }
    tx.execute("INSERT INTO composer_send_queue (id,repo_path,thread_id,intent,payload_json,payload_hash,payload_bytes,status,created_at,updated_at,ingress_json,ingress_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',?8,?8,?9,?10)",
        rusqlite::params![input.id,input.repo_path,input.thread_id,input.intent,input.payload_json,hash,bytes,now,input.ingress.map(|i|i.json),input.ingress.map(|i|i.hash)])?;
    let item = read(&tx, input.id)?.ok_or(Error::InvalidPayload)?;
    tx.commit()?;
    Ok(Change {
        item,
        changed: true,
    })
}

/// A possibly delivered dispatch is held, never replayed or silently requeued.
#[cfg(test)]
fn recover(db: &mut Connection, now: i64) -> Result<usize, Error> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = recover_rows(&tx, now)?;
    tx.commit()?;
    Ok(changed)
}
fn recover_rows(db: &Connection, now: i64) -> Result<usize, Error> {
    // Recovery must not decode payloads: the legacy UPDATE also holds a
    // partially corrupted row rather than making recovery depend on its body.
    Ok(db.execute("UPDATE composer_send_queue SET status='held',reason='Delivery interrupted. Inspect the chat before sending again.',updated_at=?1,claim_token=NULL WHERE status='dispatching'", [now])?)
}
/// Call only at authenticated producer attach. No-producer startup changes
/// nothing. The boot identity persists across daemon restarts.
pub(crate) fn attach_boot(db: &mut Connection, boot_id: &str, now: i64) -> Result<usize, Error> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let previous: Option<String> = tx
        .query_row(
            "SELECT value FROM app_state WHERE key='o8d.composer-queue.boot'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if previous.as_deref() == Some(boot_id) {
        tx.commit()?;
        return Ok(0);
    }
    let changed = recover_rows(&tx, now)?;
    tx.execute("INSERT INTO app_state(key,value,updated_at) VALUES ('o8d.composer-queue.boot',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",rusqlite::params![boot_id,now])?;
    tx.commit()?;
    Ok(changed)
}

#[cfg(test)]
#[path = "composer_queue_store_tests.rs"]
mod tests;
