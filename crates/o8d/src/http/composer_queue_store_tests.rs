use super::*;
fn fixture() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE composer_send_queue(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,repo_path TEXT,thread_id TEXT,intent TEXT,payload_json TEXT,payload_hash TEXT,payload_bytes INTEGER,payload_compacted_at INTEGER,status TEXT,reason TEXT,created_at INTEGER,updated_at INTEGER,admitted_at INTEGER,claim_token TEXT,ingress_json TEXT,ingress_hash TEXT);").unwrap();
    db.execute_batch("CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);").unwrap();
    db
}
fn admission(payload: &str) -> Admission<'_> {
    Admission {
        id: "fixture-send",
        repo_path: "/fixture",
        thread_id: "thoughts-fixture",
        intent: "send-next",
        payload_json: payload,
        ingress: None,
    }
}
#[test]
fn retry_reuses_identity_and_changed_payload_is_refused() {
    let mut db = fixture();
    let raw = r#"{"wireMessage":"fixture","routing":{"model":"unchanged","effort":"low"}}"#;
    let first = enqueue(&mut db, admission(raw), 1).unwrap();
    let retry = enqueue(&mut db, admission(raw), 2).unwrap();
    assert!(first.changed);
    assert!(!retry.changed);
    assert_eq!(first.item, retry.item);
    assert!(matches!(
        enqueue(&mut db, admission(r#"{"wireMessage":"different"}"#), 3),
        Err(Error::IdentityConflict)
    ));
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM composer_send_queue", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row("SELECT payload_json FROM composer_send_queue", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        raw
    );
}
#[test]
fn interrupted_dispatch_is_held_once_without_replay() {
    let mut db = fixture();
    enqueue(&mut db, admission(r#"{"wireMessage":"fixture"}"#), 1).unwrap();
    db.execute(
        "UPDATE composer_send_queue SET status='dispatching',admitted_at=2",
        [],
    )
    .unwrap();
    let held = recover(&mut db, 3).unwrap();
    assert_eq!(held, 1);
    assert_eq!(
        read(&db, "fixture-send").unwrap().unwrap()["status"],
        "held"
    );
    assert_eq!(read(&db, "fixture-send").unwrap().unwrap()["admittedAt"], 2);
    assert_eq!(recover(&mut db, 4).unwrap(), 0);
}
#[test]
fn accepted_before_launch_failure_is_held_and_retry_cannot_launch_again() {
    let mut db = fixture();
    let input = r#"{"wireMessage":"fixture"}"#;
    let target = Target {
        repo_path: "/fixture",
        thread_id: "thoughts-fixture",
    };
    enqueue(&mut db, admission(input), 1).unwrap();
    let attempt = claim(&mut db, &target, 2).unwrap().unwrap();
    assert!(claim(&mut db, &target, 3).unwrap().is_none());
    assert!(admit(&db, "fixture-send", &attempt.token, 4).unwrap());
    assert!(!admit(&db, "fixture-send", &attempt.token, 5).unwrap());
    // Crash after durable admission and before any provider launch.
    assert_eq!(recover(&mut db, 6).unwrap(), 1);
    let retry = enqueue(&mut db, admission(input), 7).unwrap();
    assert!(!retry.changed);
    assert_eq!(retry.item["status"], "held");
    assert!(claim(&mut db, &target, 8).unwrap().is_none());
}
#[test]
fn stale_attempt_cannot_mutate_or_admit_a_later_claim_in_the_same_epoch() {
    let mut db = fixture();
    enqueue(
        &mut db,
        admission(r#"{"wireMessage":"fixture","images":[]}"#),
        1,
    )
    .unwrap();
    let target = Target {
        repo_path: "/fixture",
        thread_id: "thoughts-fixture",
    };
    let a = claim(&mut db, &target, 2).unwrap().unwrap();
    assert!(defer_steer(&db, "fixture-send", &a.token, "known pre-admit refusal", 3).unwrap());
    let b = claim(&mut db, &target, 4).unwrap().unwrap();
    assert_ne!(a.token, b.token);
    assert_eq!(a.item["id"], b.item["id"]);
    assert!(!admit(&db, "fixture-send", &a.token, 5).unwrap());
    assert!(!settle(
        &mut db,
        "fixture-send",
        &a.token,
        "held",
        None,
        5,
        |_, _| panic!("stale compaction")
    )
    .unwrap());
    assert!(!defer_steer(&db, "fixture-send", &a.token, "stale", 5).unwrap());
    assert!(!assert_claim(&db, "fixture-send", &a.token).unwrap());
    assert!(assert_claim(&db, "fixture-send", &b.token).unwrap());
    let row = read(&db, "fixture-send").unwrap().unwrap();
    assert_eq!(row["status"], "dispatching");
    assert!(row["admittedAt"].is_null());
    assert!(!settle(
        &mut db,
        "fixture-send",
        &b.token,
        "applied",
        None,
        6,
        |_, _| panic!("unadmitted compaction")
    )
    .unwrap());
    assert!(admit(&db, "fixture-send", &b.token, 7).unwrap());
    assert!(settle(
        &mut db,
        "fixture-send",
        &b.token,
        "applied",
        None,
        8,
        |_, _| Ok(r#"{"wireMessage":"","images":[]}"#.into())
    )
    .unwrap());
    assert!(!assert_claim(&db, "fixture-send", &b.token).unwrap());
    let token: Option<String> = db
        .query_row("SELECT claim_token FROM composer_send_queue", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(token.is_none());
}
#[test]
fn only_a_different_executor_boot_recovers_and_keeps_pending_wire() {
    let mut db = fixture();
    assert_eq!(attach_boot(&mut db, "ws-boot-a", 1).unwrap(), 0);
    enqueue(
        &mut db,
        admission(r#"{"wireMessage":"fixture","images":[]}"#),
        2,
    )
    .unwrap();
    let target = Target {
        repo_path: "/fixture",
        thread_id: "thoughts-fixture",
    };
    let claimed = claim(&mut db, &target, 3).unwrap().unwrap();
    db.execute(
        "UPDATE composer_send_queue SET ingress_json='fixture-sidecar',ingress_hash='fixture-hash'",
        [],
    )
    .unwrap();
    assert_eq!(attach_boot(&mut db, "ws-boot-a", 4).unwrap(), 0);
    assert_eq!(attach_boot(&mut db, "ws-boot-a", 5).unwrap(), 0);
    assert!(assert_claim(&db, "fixture-send", &claimed.token).unwrap());
    let held = attach_boot(&mut db, "ws-boot-b", 6).unwrap();
    assert_eq!(held, 1);
    assert_eq!(
        read(&db, "fixture-send").unwrap().unwrap()["status"],
        "held"
    );
    assert!(!assert_claim(&db, "fixture-send", &claimed.token).unwrap());
    let sidecar: String = db
        .query_row("SELECT ingress_json FROM composer_send_queue", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(sidecar, "fixture-sidecar");
    assert_eq!(attach_boot(&mut db, "ws-boot-b", 7).unwrap(), 0);
}
#[test]
fn concurrent_connections_share_one_admission_and_one_claim() {
    let path = std::env::temp_dir().join(format!("o8-composer-{}.db", uuid::Uuid::new_v4()));
    let source = fixture();
    let schema: String = source
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='composer_send_queue'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch(&schema).unwrap();
    drop(db);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let mut handles = vec![];
    for _ in 0..8 {
        let path = path.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let mut db = Connection::open(path).unwrap();
            db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
            barrier.wait();
            let created = enqueue(&mut db, admission(r#"{"wireMessage":"fixture"}"#), 1)
                .unwrap()
                .changed;
            let claimed = claim(
                &mut db,
                &Target {
                    repo_path: "/fixture",
                    thread_id: "thoughts-fixture",
                },
                2,
            )
            .unwrap()
            .is_some();
            (created, claimed)
        }));
    }
    let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(outcomes.iter().filter(|o| o.0).count(), 1);
    assert_eq!(outcomes.iter().filter(|o| o.1).count(), 1);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn synthetic_ingress_is_gettable_but_never_listed_or_claimed_by_desktop() {
    let mut db = fixture();
    for thread in ["wsi:null-fixture", "wsi:non-thoughts-fixture"] {
        enqueue(
            &mut db,
            Admission {
                id: thread,
                repo_path: "/fixture",
                thread_id: thread,
                intent: "send-next",
                payload_json: r#"{"text":"fixture","wireMessage":"fixture","images":[]}"#,
                ingress: None,
            },
            1,
        )
        .unwrap();
        db.execute("UPDATE composer_send_queue SET ingress_json='{\"message\":\"fixture-wire\"}',ingress_hash='fixture-hash' WHERE id=?1",[thread]).unwrap();
        let target = Target {
            repo_path: "/fixture",
            thread_id: thread,
        };
        assert!(list(&db, &target).unwrap().is_empty());
        assert!(claim(&mut db, &target, 2).unwrap().is_none());
        assert!(read(&db, thread).unwrap().is_some());
        let claim = claim_ingress(&mut db, thread, 3).unwrap().unwrap();
        assert!(assert_claim(&db, thread, &claim.token).unwrap());
        assert!(claim_ingress(&mut db, thread, 4).unwrap().is_none());
    }
}
#[test]
fn failed_compaction_rolls_back_and_success_clears_only_terminal_wire() {
    let mut db = fixture();
    db.pragma_update(None, "secure_delete", 0).unwrap();
    let raw = r#"{"text":"fixture","wireMessage":"fixture","images":[]}"#;
    enqueue(&mut db, admission(raw), 1).unwrap();
    db.execute(
        "UPDATE composer_send_queue SET ingress_json='{\"message\":\"pending-wire\"}',ingress_hash='retained-hash'",
        [],
    )
    .unwrap();
    let claim = claim_ingress(&mut db, "fixture-send", 2).unwrap().unwrap();
    assert!(admit(&db, "fixture-send", &claim.token, 3).unwrap());
    assert!(settle(
        &mut db,
        "fixture-send",
        &claim.token,
        "applied",
        None,
        4,
        |_, _| Err(Error::InvalidPayload)
    )
    .is_err());
    assert!(assert_claim(&db, "fixture-send", &claim.token).unwrap());
    let wire: String = db
        .query_row("SELECT ingress_json FROM composer_send_queue", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(wire, r#"{"message":"pending-wire"}"#);
    assert!(settle(
        &mut db,
        "fixture-send",
        &claim.token,
        "applied",
        None,
        5,
        |s, steer| super::super::composer_queue_payload::compact(s, steer, None)
            .map_err(|_| Error::InvalidPayload)
    )
    .unwrap());
    let (wire, hash): (Option<String>, String) = db
        .query_row(
            "SELECT ingress_json,ingress_hash FROM composer_send_queue",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(wire.is_none());
    assert_eq!(hash, "retained-hash");
    let mode: i64 = db
        .pragma_query_value(None, "secure_delete", |r| r.get(0))
        .unwrap();
    assert_eq!(mode, 0);
}

#[test]
fn ingress_retry_keeps_first_selection_and_desktop_cannot_supply_one() {
    let mut db = fixture();
    let first = r#"{"wireMessage":"fixture","images":[],"wsSelection":{"model":"first","thinkingEffort":"low"}}"#;
    let second = r#"{"wireMessage":"fixture","images":[],"wsSelection":{"model":"later","thinkingEffort":"high"}}"#;
    assert!(enqueue(&mut db, admission(first), 1).is_err());
    let ingress = Ingress {
        json: r#"{"message":"fixture"}"#,
        hash: "same-original-wire-hash",
    };
    let input = |raw| Admission {
        id: "fixture-ingress",
        repo_path: "/fixture",
        thread_id: "thoughts-fixture",
        intent: "send-next",
        payload_json: raw,
        ingress: Some(&ingress),
    };
    let made = enqueue(&mut db, input(first), 2).unwrap();
    let retry = enqueue(&mut db, input(second), 3).unwrap();
    assert!(made.changed);
    assert!(!retry.changed);
    assert_eq!(retry.item, made.item);
    let different = Ingress {
        json: ingress.json,
        hash: "different-wire-hash",
    };
    assert!(matches!(
        enqueue(
            &mut db,
            Admission {
                ingress: Some(&different),
                ..input(first)
            },
            4
        ),
        Err(Error::IdentityConflict)
    ));
}
#[test]
fn cancelled_steer_removes_text_while_hold_compacts_only_admitted_work() {
    let mut db = fixture();
    let raw = r#"{"text":"private text","wireMessage":"private wire","images":[]}"#;
    let target = Target {
        repo_path: "/fixture",
        thread_id: "thoughts-fixture",
    };
    let mut input = admission(raw);
    input.intent = "steer-now";
    enqueue(&mut db, input, 1).unwrap();
    let compact = |s: &str, b: bool| {
        super::super::composer_queue_payload::compact(s, b, None).map_err(|_| Error::InvalidPayload)
    };
    assert!(cancel(&mut db, &target, "fixture-send", 2, compact).unwrap());
    assert!(!cancel(&mut db, &target, "fixture-send", 3, compact).unwrap());
    assert_eq!(
        read(&db, "fixture-send").unwrap().unwrap()["payload"]["text"],
        ""
    );
    for (id, admitted) in [("delivered", true), ("unadmitted", false)] {
        let mut input = admission(raw);
        input.id = id;
        input.intent = "steer-now";
        enqueue(&mut db, input, 4).unwrap();
        let claim = claim_steer(&mut db, id, 5).unwrap().unwrap();
        if admitted {
            assert!(admit(&db, id, &claim.token, 6).unwrap());
        }
    }
    assert!(hold(&mut db, &target, 7, compact).unwrap());
    let delivered = read(&db, "delivered").unwrap().unwrap();
    assert_eq!(delivered["status"], "applied");
    assert_eq!(delivered["payload"]["text"], "private text");
    assert_eq!(read(&db, "unadmitted").unwrap().unwrap()["status"], "held");
    assert!(!hold(&mut db, &target, 8, compact).unwrap());
}
#[test]
fn recovery_holds_an_unparseable_payload_without_decoding_or_replaying_it() {
    let mut db = fixture();
    enqueue(&mut db, admission(r#"{"wireMessage":"fixture"}"#), 1).unwrap();
    db.execute(
        "UPDATE composer_send_queue SET status='dispatching',payload_json='partial JSON'",
        [],
    )
    .unwrap();
    assert_eq!(attach_boot(&mut db, "new-ws-boot", 2).unwrap(), 1);
    let (state, raw): (String, String) = db
        .query_row(
            "SELECT status,payload_json FROM composer_send_queue",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "held");
    assert_eq!(raw, "partial JSON");
}
