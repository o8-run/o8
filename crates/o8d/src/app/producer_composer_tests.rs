use super::*;
use crate::http::composer_queue_owner::Owner;
struct Fixture {
    root: PathBuf,
    owner: Arc<Owner>,
    global: Arc<super::super::native_global::NativeGlobal>,
    authority: Arc<Mutex<watch::Sender<Option<Arc<Producer>>>>>,
    target: Value,
    raw: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("o8-queue-producer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("chat-history")).unwrap();
        std::fs::create_dir(root.join("repo")).unwrap();
        let target = json!({"repoPath":root.join("repo"),"threadId":"thoughts-fixture"});
        std::fs::write(
            root.join("chat-history/thoughts-fixture.json"),
            json!({"messages":[],"repoPath":target["repoPath"]}).to_string(),
        )
        .unwrap();
        let owner = Arc::new(Owner::new(root.clone(), root.join("media")).unwrap());
        let global = super::super::native_global::NativeGlobal::with_composer(owner.clone());
        let (selected, _) = watch::channel(None);
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/o8d-composer-ledger-vectors.json"
        ))
        .unwrap();
        Self {
            root,
            owner,
            global,
            authority: Arc::new(Mutex::new(selected)),
            target,
            raw: vectors[0]["serialized"].as_str().unwrap().into(),
        }
    }
    async fn attach(
        &self,
        boot: &str,
        generation: u64,
    ) -> (
        BufReader<UnixStream>,
        tokio::task::JoinHandle<Result<(), ()>>,
        String,
    ) {
        let (peer, daemon) = UnixStream::pair().unwrap();
        let authority = self.authority.clone();
        let global = self.global.clone();
        let task = tokio::spawn(async move {
            attach(daemon, "fixture-key", 18001, generation, authority, global).await
        });
        let mut peer = BufReader::new(peer);
        peer.get_mut().write_all(format!("{}\n",json!({"version":1,"key":"fixture-key","upstream":"127.0.0.1:18002","epoch":"realtime-unchanged","composerQueueBootId":boot})).as_bytes()).await.unwrap();
        let ack: Value = serde_json::from_slice(&line(&mut peer, 4096).await.unwrap()).unwrap();
        assert_eq!(ack["epoch"], "realtime-unchanged");
        let epoch = ack["composerQueueEpoch"].as_str().unwrap().to_owned();
        (peer, task, epoch)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
async fn call(
    peer: &mut BufReader<UnixStream>,
    epoch: &str,
    method: &str,
    params: Value,
    notices: &mut Vec<Value>,
) -> Value {
    peer.get_mut().write_all(format!("{}\n",json!({"v":1,"kind":"composer-queue-request","epoch":epoch,"requestId":"fixture-request","method":method,"params":params})).as_bytes()).await.unwrap();
    loop {
        let value: Value =
            serde_json::from_slice(&line(peer, 100 * 1024 * 1024).await.unwrap()).unwrap();
        if value["kind"] == "native-commit" {
            notices.push(value);
            continue;
        }
        assert_eq!(value["kind"], "composer-queue-response");
        assert_eq!(value["epoch"], epoch);
        assert_eq!(value["requestId"], "fixture-request");
        return value;
    }
}
#[tokio::test]
async fn composer_queue_rpc_uses_its_own_epoch_and_only_a_new_boot_recovers() {
    let f = Fixture::new();
    let mut notices = vec![];
    let (mut peer, task, epoch) = f.attach("boot-a", 1).await;
    let input =
        json!({"id":"producer-fixture","target":f.target,"intent":"send-next","payloadJson":f.raw});
    assert_eq!(
        call(&mut peer, &epoch, "enqueue", input, &mut notices).await["result"]["disposition"],
        "created"
    );
    let claim = call(
        &mut peer,
        &epoch,
        "claim",
        json!({"target":f.target,"intent":"send-next"}),
        &mut notices,
    )
    .await;
    let token = &claim["result"]["claimToken"];
    assert_eq!(
        call(
            &mut peer,
            &epoch,
            "admit",
            json!({"id":"producer-fixture","claimToken":token}),
            &mut notices
        )
        .await["result"]["changed"],
        true
    );
    call(
        &mut peer,
        &epoch,
        "get",
        json!({"id":"producer-fixture"}),
        &mut notices,
    )
    .await;
    assert_eq!(notices.len(), 3);
    for notice in &notices {
        assert_eq!(notice["epoch"], "realtime-unchanged");
        assert_eq!(notice["request"]["mutation"].as_object().unwrap().len(), 7);
        assert_eq!(notice["request"]["mutation"]["source"], "desktop");
        assert_eq!(notice["request"]["mutation"]["action"], "composer-queue");
        assert!(notice.to_string().len() <= 16 * 1024);
    }
    drop(peer);
    assert!(task.await.unwrap().is_err());
    let (mut peer, task, next) = f.attach("boot-a", 2).await;
    assert_ne!(epoch, next);
    let stale = call(
        &mut peer,
        &epoch,
        "settle",
        json!({"id":"producer-fixture","claimToken":token,"status":"held"}),
        &mut notices,
    )
    .await;
    assert_eq!(stale["error"]["code"], "stale_epoch");
    let row = call(
        &mut peer,
        &next,
        "get",
        json!({"id":"producer-fixture","claimToken":token}),
        &mut notices,
    )
    .await;
    assert_eq!(row["result"]["item"]["status"], "dispatching");
    assert_eq!(
        row["result"]["attempt"],
        json!({"tokenMatches":true,"admitted":true})
    );
    drop(peer);
    assert!(task.await.unwrap().is_err());
    let (mut peer, task, next) = f.attach("boot-b", 3).await;
    let row = call(
        &mut peer,
        &next,
        "get",
        json!({"id":"producer-fixture","claimToken":token}),
        &mut notices,
    )
    .await;
    assert_eq!(row["result"]["item"]["status"], "held");
    assert_eq!(row["result"]["attempt"]["tokenMatches"], false);
    assert_eq!(notices.len(), 3);
    // Owner restarts with the live boot retain the recovery decision.
    let reopened = Owner::new(f.root.clone(), f.root.join("media")).unwrap();
    assert_eq!(reopened.attach("boot-b").unwrap(), 0);
    assert!(f
        .owner
        .execute("get", &json!({"id":"producer-fixture"}))
        .unwrap()
        .notice
        .is_none());
    drop(peer);
    assert!(task.await.unwrap().is_err());
}
