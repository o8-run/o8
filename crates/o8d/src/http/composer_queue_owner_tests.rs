use super::*;
struct Fixture {
    root: PathBuf,
    owner: Owner,
    target: Value,
    raw: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("o8-queue-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("chat-history")).unwrap();
        std::fs::create_dir(root.join("repo")).unwrap();
        let repo = root.join("repo").to_str().unwrap().to_owned();
        std::fs::write(
            root.join("chat-history/thoughts-fixture.json"),
            json!({"messages":[],"repoPath":repo}).to_string(),
        )
        .unwrap();
        let owner = Owner::new(root.clone(), root.join("media")).unwrap();
        let vector: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/o8d-composer-ledger-vectors.json"
        ))
        .unwrap();
        Self {
            root,
            owner,
            target: json!({"repoPath":repo,"threadId":"thoughts-fixture"}),
            raw: vector[0]["serialized"].as_str().unwrap().into(),
        }
    }
    fn enqueue(&self) -> Answer {
        self.owner.execute("enqueue",&json!({"id":"fixture-owner","target":self.target,"intent":"send-next","payloadJson":self.raw})).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn real_owner_keeps_attempt_fences_and_emits_only_changed_mutation_notices() {
    let f = Fixture::new();
    let first = f.enqueue();
    assert!(first.notice.is_some());
    assert!(f.enqueue().notice.is_none());
    let claim = |intent: &str| {
        f.owner
            .execute(
                "claim",
                &json!({"id":"fixture-owner","target":f.target,"intent":intent}),
            )
            .unwrap()
    };
    let a = claim("send-next");
    let ta = &a.result["claimToken"];
    assert!(a.notice.is_some());
    assert!(a.result["item"].get("claimToken").is_none());
    let defer = f
        .owner
        .execute(
            "deferSteer",
            &json!({"id":"fixture-owner","claimToken":ta,"reason":"Not admitted"}),
        )
        .unwrap();
    assert!(defer.notice.is_some());
    let b = claim("send-next");
    let tb = &b.result["claimToken"];
    assert_ne!(ta, tb);
    for method in ["admit", "settle", "deferSteer", "assertClaim"] {
        let answer = f
            .owner
            .execute(
                method,
                &json!({"id":"fixture-owner","claimToken":ta,"status":"held","reason":"stale"}),
            )
            .unwrap();
        assert!(answer.notice.is_none());
        assert_eq!(
            answer.result[if method == "assertClaim" {
                "live"
            } else {
                "changed"
            }],
            false
        );
    }
    let before = f
        .owner
        .execute(
            "settle",
            &json!({"id":"fixture-owner","claimToken":tb,"status":"applied"}),
        )
        .unwrap();
    assert_eq!(before.result["changed"], false);
    assert!(before.notice.is_none());
    let get = f
        .owner
        .execute("get", &json!({"id":"fixture-owner","claimToken":tb}))
        .unwrap();
    assert_eq!(
        get.result["attempt"],
        json!({"tokenMatches":true,"admitted":false})
    );
    assert!(f
        .owner
        .execute("admit", &json!({"id":"fixture-owner","claimToken":tb}))
        .unwrap()
        .notice
        .is_some());
    let settled = f
        .owner
        .execute(
            "settle",
            &json!({"id":"fixture-owner","claimToken":tb,"status":"applied"}),
        )
        .unwrap();
    assert!(settled.notice.is_some());
    assert!(f.enqueue().notice.is_none());
    for method in [
        "claim",
        "admit",
        "settle",
        "deferSteer",
        "assertClaim",
        "hold",
    ] {
        assert!(!Owner::internal_method(method));
    }
}

#[test]
fn media_root_keeps_unset_absolute_and_relative_node_join_semantics() {
    use std::ffi::OsStr;
    assert_eq!(
        media_root(Path::new("/fixture/data"), None)
            .unwrap()
            .join("orchestrator-images"),
        PathBuf::from("/fixture/data/media/orchestrator-images")
    );
    assert_eq!(
        media_root(
            Path::new("/fixture/data"),
            Some(OsStr::new("/fixture/override"))
        )
        .unwrap()
        .join("orchestrator-images"),
        PathBuf::from("/fixture/override/orchestrator-images")
    );
    let relative = media_root(
        Path::new("/fixture/data"),
        Some(OsStr::new("./media-override/../relative")),
    )
    .unwrap()
    .join("orchestrator-images");
    assert_eq!(relative, PathBuf::from("relative/orchestrator-images"));
    assert_eq!(
        std::env::current_dir().unwrap().join(&relative),
        std::env::current_dir()
            .unwrap()
            .join("relative/orchestrator-images")
    );
}
#[test]
fn retry_keeps_unsaved_target_after_history_appears_and_rejects_changed_wire() {
    let f = Fixture::new();
    for saved in [false, true] {
        let thread = if saved {
            "thoughts-fixture"
        } else {
            "thoughts-created-later"
        };
        let wire=json!({"type":"orchestrator-send","repoPath":f.target["repoPath"],"threadId":thread,"message":"fixture","clientMutationId":"fixture-mutation"}).to_string();
        let (id, synthetic) = composer_queue_ingress::identity(
            f.target["repoPath"].as_str().unwrap(),
            Some(thread),
            "fixture-mutation",
        )
        .unwrap();
        let target = if saved { thread } else { &synthetic };
        let mut input = json!({"id":id,"target":{"repoPath":f.target["repoPath"],"threadId":target},"intent":"send-next","payloadJson":f.raw,"ingress":{"kind":"ws","clientMutationId":"fixture-mutation","wireJson":wire}});
        let first = f.owner.execute("enqueue", &input).unwrap();
        assert_eq!(first.result["disposition"], "created");
        assert_eq!(first.notice.is_some(), saved);
        if !saved {
            std::fs::write(
                f.root.join("chat-history").join(format!("{thread}.json")),
                json!({"messages":[],"repoPath":f.target["repoPath"]}).to_string(),
            )
            .unwrap();
        }
        input["target"]["threadId"] = json!(thread);
        // Model the TS client sending the first payload back after a native
        // response: serde's parsed object order differs from JSON.stringify's
        // normalization order. Wire identity and first target still win.
        input["payloadJson"] = json!(serde_json::from_str::<Value>(&f.raw).unwrap().to_string());
        let retry = f.owner.execute("enqueue", &input).unwrap();
        assert_eq!(retry.result["disposition"], "existing");
        assert_eq!(retry.result["item"], first.result["item"]);
        assert!(retry.notice.is_none());
        let mut parsed: Value = serde_json::from_str(&wire).unwrap();
        parsed["message"] = json!("changed");
        input["ingress"]["wireJson"] = json!(parsed.to_string());
        assert_eq!(
            f.owner.execute("enqueue", &input).err().unwrap().code,
            "conflict"
        );
        let claim = f
            .owner
            .execute("claim", &json!({"id":id,"intent":"ingress"}))
            .unwrap();
        assert_eq!(claim.result["ingress"]["kind"], "ws");
        assert_eq!(
            claim.result["ingress"]["clientMutationId"],
            "fixture-mutation"
        );
        assert_eq!(
            serde_json::from_str::<Value>(claim.result["ingress"]["wireJson"].as_str().unwrap())
                .unwrap(),
            serde_json::from_str::<Value>(&wire).unwrap()
        );
    }
}

#[test]
fn empty_claim_has_an_explicit_private_null_token() {
    let f = Fixture::new();
    assert_eq!(
        f.owner
            .execute("claim", &json!({"target":f.target,"intent":"send-next"}))
            .unwrap()
            .result,
        json!({"item":null,"claimToken":null})
    );
}
