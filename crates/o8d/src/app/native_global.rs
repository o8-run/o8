//! Daemon-owned global delivery while the Node producer is absent. No commands
//! or session streams are executed here; producer delivery keeps its own bus.
use crate::EventBus;
use std::sync::Arc;

pub(super) const EPOCH_PREFIX: &str = "o8d-native:";
pub(super) struct NativeGlobal {
    bus: EventBus,
    #[cfg(feature = "experimental-session-reads")]
    pub(super) composer_queue: Option<Arc<crate::http::composer_queue_owner::Owner>>,
    #[cfg(feature = "experimental-session-reads")]
    sequence: tokio::sync::Mutex<u64>,
}
impl NativeGlobal {
    pub(super) fn new() -> Arc<Self> {
        #[cfg(feature = "experimental-session-reads")]
        // The TS queue stays the single writer until its client opts in; an
        // unclaimed owner must not open or migrate the shared queue tables.
        let composer_queue=if std::env::var_os("O8D_SESSION_DATA_DIR").is_some()
            && std::env::var("O8D_COMPOSER_OWNER").as_deref()==Ok("1") {
            match crate::http::composer_queue_owner::Owner::configured() {
                Ok(owner)=>Some(Arc::new(owner)),
                Err(_)=>{eprintln!("[o8d] composer queue initialization unavailable");None},
            }
        }else{None};
        Arc::new(Self {
            #[cfg(feature = "experimental-session-reads")]
            composer_queue,
            bus: EventBus::new(format!("{EPOCH_PREFIX}{}", uuid::Uuid::new_v4()), 400),
            #[cfg(feature = "experimental-session-reads")]
            sequence: tokio::sync::Mutex::new(0),
        })
    }

    #[cfg(all(test,feature="experimental-session-reads"))]
    pub(super) fn with_composer(owner:Arc<crate::http::composer_queue_owner::Owner>)->Arc<Self> {
        Arc::new(Self{bus:EventBus::new(format!("{EPOCH_PREFIX}{}",uuid::Uuid::new_v4()),400),sequence:tokio::sync::Mutex::new(0),composer_queue:Some(owner)})
    }

    #[cfg(feature = "experimental-session-reads")]
    pub(super) async fn committed(
        &self,
        request: serde_json::Value,
        selection: &super::Selection,
        header: &str,
    ) {
        use serde_json::json;
        let producer = selection.borrow().clone();
        let result = if let Some(producer) = producer {
            let wire = json!({"version":1,"kind":"native-commit","epoch":producer.bus.epoch(),"request":request.clone()}).to_string()+"\n";
            if wire.len() > 16 * 1024 {
                Err(())
            } else if producer.notices.is_none() {
                // Compatibility with the existing static app backhaul. Reuse
                // its operator-authenticated realtime endpoint, not a new gate.
                super::native::publish_legacy_notice(&producer, request, header).await
            } else {
                producer
                    .notices
                    .as_ref()
                    .ok_or(())
                    .and_then(|tx| tx.try_send(wire).map_err(|_| ()))
            }
        } else {
            let mut seq = self.sequence.lock().await;
            *seq += 1;
            self.bus.publish(vec![json!({"protocol":1,"seq":*seq,"stream":"global","channel":"mutation",
                "event":"mutation.settled","ts":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
                "entityId":request["mutation"]["surfaceId"],"health":{"state":"live"},"data":{"mutation":request["mutation"]}})]).await.map_err(|_| ())
        };
        if result.is_err() {
            eprintln!("[o8d] committed notification unavailable");
        }
    }

    /// Only the debug launcher's inherited lifeline can request this fixed
    /// fixture commit. No network command or arbitrary payload is accepted.
    #[cfg(all(debug_assertions, feature = "experimental-session-reads"))]
    pub(super) async fn fixture_commit(&self) {
        use serde_json::json;
        let mut seq = self.sequence.lock().await;
        *seq += 1;
        let ts = chrono::Utc::now().to_rfc3339();
        let _ = self.bus.publish(vec![json!({"protocol":1,"stream":"global","seq":*seq,
            "channel":"mutation","event":"settled","ts":ts,
            "data":{"mutation":{"mutationId":format!("native-fixture-{seq}"),"source":"server",
                "action":"launcher-fixture","status":"completed","surfaceId":std::process::id().to_string(),"createdAt":ts}}})]).await;
    }
}

#[cfg(feature = "experimental-session-reads")]
fn global_subscription(frame: &serde_json::Value) -> bool {
    frame.as_object().is_some_and(|o| o.len() == 2)
        && frame["type"] == "realtime-subscribe"
        && frame["subscriptions"]
            .as_array()
            .is_some_and(|subscriptions| {
                subscriptions.len() == 1
                    && subscriptions[0].as_object().is_some_and(|o| o.len() == 1)
                    && subscriptions[0]["stream"] == "global"
            })
}

#[cfg(feature = "experimental-session-reads")]
pub(super) async fn serve(
    stream: tokio::net::TcpStream,
    token: String,
    global: Arc<NativeGlobal>,
    mut selection: super::Selection,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(), ()> {
    use super::{producer_close, prompt_operator, send};
    use futures_util::StreamExt;
    use serde_json::{json, Value};
    use std::time::Duration;
    use tokio_tungstenite::{
        accept_async_with_config,
        tungstenite::{protocol::WebSocketConfig, Message},
    };
    // Selection was captured before upgrade. Never grant against a producer
    // that attached in between the independent gate and the handshake.
    if selection.borrow().is_some() || *shutdown.borrow() {
        return super::close_unavailable(stream).await;
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(16 * 1024))
        .max_frame_size(Some(16 * 1024));
    let mut socket = tokio::time::timeout(
        Duration::from_secs(5),
        accept_async_with_config(stream, Some(config)),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    let mut live = global.bus.listen();
    let mut watermark = None;
    let mut alive = true;
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(25),
        Duration::from_secs(25),
    );
    loop {
        tokio::select! {
            biased;
            _ = selection.changed() => { let _ = send(&mut socket, producer_close()).await; return Ok(()); }
            _ = shutdown.changed() => { let _ = send(&mut socket, producer_close()).await; return Ok(()); }
            _ = heartbeat.tick() => {
                if !alive || prompt_operator::current_token(&token).is_none() {
                    let _ = send(&mut socket, producer_close()).await; return Ok(());
                }
                alive = false;
                send(&mut socket, Message::Ping(vec![].into())).await?;
            }
            publication = live.recv(), if watermark.is_some() => {
                let events = match publication {
                    Ok(events) if prompt_operator::current_token(&token).is_some() => events,
                    _ => { let _ = send(&mut socket, producer_close()).await; return Ok(()); }
                };
                let events: Vec<_> = events.into_iter().filter(|e| e["seq"].as_u64().unwrap_or(0) > watermark.unwrap()).collect();
                if let Some(last) = events.last() {
                    watermark = last["seq"].as_u64();
                    send(&mut socket, super::batch("global", events, global.bus.epoch())).await?;
                }
            }
            message = socket.next() => {
                let Some(Ok(message)) = message else { return Ok(()); };
                if prompt_operator::current_token(&token).is_none() || selection.borrow().is_some() {
                    let _ = send(&mut socket, producer_close()).await; return Ok(());
                }
                match message {
                    Message::Close(_) => return Ok(()),
                    Message::Ping(data) => { send(&mut socket, Message::Pong(data)).await?; }
                    Message::Pong(_) => { alive = true; }
                    Message::Text(raw) => {
                        let frame = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
                        if global_subscription(&frame) && watermark.is_none() {
                            // Listen before this atomic snapshot and suppress queued
                            // events through its watermark, preventing duplicates.
                            let checkpoint = global.bus.replay("global", None, None).await;
                            send(&mut socket, Message::text(json!({"channel":"system","event":"connected","data":{
                                "clientId":uuid::Uuid::new_v4().to_string(),"gateway":"disabled","realtimeSeq":checkpoint.latest,
                                "instanceId":std::env::var("O8_INSTANCE_ID").unwrap_or_default(),
                                "bootId":std::env::var("O8_BOOT_ID").unwrap_or_default()}}).to_string())).await?;
                            send(&mut socket, Message::text(json!({"channel":"realtime","event":"batch","data":{
                                "delivery":"bootstrap","stream":"global","latestSeq":checkpoint.latest,
                                "epoch":global.bus.epoch(),"events":checkpoint.events}}).to_string())).await?;
                            watermark = Some(checkpoint.latest);
                        } else if watermark.is_some() && frame.as_object().is_some_and(|o| o.len() == 1) && frame["type"] == "ping" {
                            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| ())?.as_millis() as u64;
                            send(&mut socket, Message::text(json!({"channel":"pong","ts":ts}).to_string())).await?;
                        } else {
                            let _ = send(&mut socket, producer_close()).await; return Ok(());
                        }
                    }
                    _ => { let _ = send(&mut socket, producer_close()).await; return Ok(()); }
                }
            }
        }
    }
}

#[cfg(all(test, feature = "experimental-session-reads"))]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_a_fresh_global_subscription_is_supported() {
        assert!(global_subscription(
            &json!({"type":"realtime-subscribe","subscriptions":[{"stream":"global"}]})
        ));
        for bad in [
            json!({"type":"realtime-subscribe","subscriptions":[{"stream":"global","since":0}]}),
            json!({"type":"realtime-subscribe","subscriptions":[{"stream":"global","epoch":"old"}]}),
            json!({"type":"realtime-subscribe","subscriptions":[{"stream":"session:x"}]}),
            json!({"type":"realtime-subscribe","subscriptions":[{"stream":"global"},{"stream":"global"}]}),
            json!({"type":"orchestrator-send"}),
        ] {
            assert!(!global_subscription(&bad));
        }
    }
    #[tokio::test]
    async fn daemon_bus_has_its_own_epoch_and_snapshot_watermark() {
        let a = NativeGlobal::new();
        let b = NativeGlobal::new();
        assert!(a.bus.epoch().starts_with(EPOCH_PREFIX));
        assert_ne!(a.bus.epoch(), b.bus.epoch());
        a.fixture_commit().await;
        let replay = a.bus.replay("global", None, None).await;
        assert_eq!(replay.latest, 1);
        assert_eq!(replay.events.len(), 1);
        assert_eq!(b.bus.latest().await, 0);
    }
}
