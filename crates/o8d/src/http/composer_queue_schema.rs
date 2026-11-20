//! Queue-only additive bootstrap and the existing v75 data rewrite. Node may
//! still perform its idempotent DDL; only this owner rewrites ledger rows.
use super::composer_queue_store::{removing_payload, Error};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

fn has_column(db: &Connection, name: &str) -> Result<bool, Error> {
    Ok(db
        .prepare("PRAGMA table_info(composer_send_queue)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == name))
}
pub(crate) fn initialize(
    db: &mut Connection,
    now: i64,
    mut compact: impl FnMut(&str, bool) -> Result<String, Error>,
) -> Result<usize, Error> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS composer_send_queue (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
        repo_path TEXT NOT NULL,thread_id TEXT NOT NULL,intent TEXT NOT NULL,
        payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',reason TEXT,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,admitted_at INTEGER);
        CREATE INDEX IF NOT EXISTS idx_composer_send_queue_target ON composer_send_queue(repo_path,thread_id,status,sequence);
        CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);")?;
    for (name, kind) in [
        ("payload_hash", "TEXT"),
        ("payload_bytes", "INTEGER"),
        ("payload_compacted_at", "INTEGER"),
        ("ingress_json", "TEXT"),
        ("ingress_hash", "TEXT"),
        ("claim_token", "TEXT"),
    ] {
        if !has_column(db, name)? {
            if let Err(error) = db.execute_batch(&format!(
                "ALTER TABLE composer_send_queue ADD COLUMN {name} {kind}"
            )) {
                // A simultaneous legacy DDL owner may have added the column
                // while this connection waited for the SQLite schema lock.
                if !has_column(db, name)? {
                    return Err(error.into());
                }
            }
        }
    }
    removing_payload(db, |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut count = 0;
        loop {
            let row:Option<(i64,String,String,Option<i64>,String)>=tx.query_row(
                "SELECT sequence,payload_json,status,admitted_at,intent FROM composer_send_queue WHERE payload_hash IS NULL OR (payload_compacted_at IS NULL AND (status='cancelled' OR (status='applied' AND admitted_at IS NOT NULL))) ORDER BY sequence LIMIT 1",[],
                |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            let Some((sequence, raw, status, admitted, intent)) = row else {
                break;
            };
            let terminal = status == "cancelled" || status == "applied" && admitted.is_some();
            let saved = if terminal {
                compact(&raw, status == "applied" && intent == "steer-now")?
            } else {
                raw.clone()
            };
            let hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
            tx.execute("UPDATE composer_send_queue SET payload_hash=COALESCE(payload_hash,?1),payload_bytes=COALESCE(payload_bytes,?2),payload_json=?3,payload_compacted_at=?4,ingress_json=CASE WHEN ?5 THEN NULL ELSE ingress_json END WHERE sequence=?6",
                rusqlite::params![hash,raw.len() as i64,saved,terminal.then_some(now),terminal,sequence])?;
            count += 1;
        }
        // A previously compacted row may predate the sidecar retention rule.
        tx.execute("UPDATE composer_send_queue SET ingress_json=NULL WHERE ingress_json IS NOT NULL AND (status='cancelled' OR (status='applied' AND admitted_at IS NOT NULL))",[])?;
        tx.commit()?;
        Ok(count)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cold_bootstrap_and_legacy_v75_rewrite_are_idempotent_and_keep_pending_payload() {
        let mut db = Connection::open_in_memory().unwrap();
        let compactor = |s: &str, steer: bool| {
            super::super::composer_queue_payload::compact(s, steer, None)
                .map_err(|_| Error::InvalidPayload)
        };
        assert_eq!(initialize(&mut db, 1, compactor).unwrap(), 0);
        let raw = r#"{"text":"kept","wireMessage":"private wire","images":[],"routing":{"effort":"low","model":"unchanged"}}"#;
        for (id, status, admitted) in [
            ("pending", "queued", None),
            ("delivered", "applied", Some(2)),
            ("removed", "cancelled", None),
        ] {
            db.execute("INSERT INTO composer_send_queue(id,repo_path,thread_id,intent,payload_json,status,created_at,updated_at,admitted_at,ingress_json) VALUES (?1,'/fixture','thoughts-fixture','send-next',?2,?3,1,1,?4,'fixture-ingress')",rusqlite::params![id,raw,status,admitted]).unwrap();
        }
        assert_eq!(initialize(&mut db, 3, compactor).unwrap(), 3);
        assert_eq!(initialize(&mut db, 4, compactor).unwrap(), 0);
        let pending: (String, String) = db
            .query_row(
                "SELECT payload_json,ingress_json FROM composer_send_queue WHERE id='pending'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(pending, (raw.into(), "fixture-ingress".into()));
        for id in ["delivered", "removed"] {
            let (saved,hash,bytes,ingress):(String,String,i64,Option<String>)=db.query_row("SELECT payload_json,payload_hash,payload_bytes,ingress_json FROM composer_send_queue WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
            assert_eq!(saved, compactor(raw, false).unwrap());
            assert_eq!(hash, format!("{:x}", Sha256::digest(raw.as_bytes())));
            assert_eq!(bytes, raw.len() as i64);
            assert!(ingress.is_none());
        }
    }

    #[test]
    fn daemon_restart_with_the_same_live_executor_preserves_dispatching() {
        let path =
            std::env::temp_dir().join(format!("o8-composer-boot-{}.db", uuid::Uuid::new_v4()));
        let compact = |s: &str, steer: bool| {
            super::super::composer_queue_payload::compact(s, steer, None)
                .map_err(|_| Error::InvalidPayload)
        };
        let token;
        {
            let mut db = Connection::open(&path).unwrap();
            initialize(&mut db, 1, compact).unwrap();
            super::super::composer_queue_store::attach_boot(&mut db, "same-ws-boot", 2).unwrap();
            super::super::composer_queue_store::enqueue(
                &mut db,
                super::super::composer_queue_store::Admission {
                    id: "fixture-restart",
                    repo_path: "/fixture",
                    thread_id: "thoughts-fixture",
                    intent: "send-next",
                    payload_json: r#"{"wireMessage":"fixture","images":[]}"#,
                    ingress: None,
                },
                3,
            )
            .unwrap();
            token = super::super::composer_queue_store::claim(
                &mut db,
                &super::super::composer_queue_store::Target {
                    repo_path: "/fixture",
                    thread_id: "thoughts-fixture",
                },
                4,
            )
            .unwrap()
            .unwrap()
            .token;
        }
        {
            let mut db = Connection::open(&path).unwrap();
            initialize(&mut db, 5, compact).unwrap();
            assert_eq!(
                super::super::composer_queue_store::attach_boot(&mut db, "same-ws-boot", 6)
                    .unwrap(),
                0
            );
            assert!(super::super::composer_queue_store::assert_claim(
                &db,
                "fixture-restart",
                &token
            )
            .unwrap());
        }
        std::fs::remove_file(path).unwrap();
    }
}
