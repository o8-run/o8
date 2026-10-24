#[cfg(feature = "experimental-ws")]
use o8d::{
    websocket::{serve, ServerConfig},
    EventBus,
};
#[cfg(feature = "experimental-ws")]
use serde_json::{json, Value};
use std::env;
#[cfg(feature = "experimental-ws")]
use std::sync::Arc;
#[cfg(feature = "experimental-ws")]
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpListener,
};
#[cfg(feature = "experimental-ws")]
use uuid::Uuid;

#[tokio::main(worker_threads = 2)]
async fn main() {
    if run().await.is_err() {
        eprintln!("o8d failed: verify opt-in, listener, credential, and producer input");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments
        .iter()
        .any(|argument| argument == "--experimental-mcp")
    {
        #[cfg(feature = "experimental-mcp")]
        return o8d::mcp::run(&arguments).await;
        #[cfg(not(feature = "experimental-mcp"))]
        return Err("MCP unavailable".into());
    }
    if arguments
        .iter()
        .any(|argument| argument == "--experimental-http")
    {
        #[cfg(feature = "experimental-http")]
        return o8d::http::run(&arguments).await;
        #[cfg(not(feature = "experimental-http"))]
        return Err("HTTP reads unavailable".into());
    }
    if arguments
        .iter()
        .any(|argument| argument == "--experimental-supervisor")
    {
        #[cfg(all(feature = "experimental-supervisor", target_os = "linux"))]
        return o8d::supervisor::run(&arguments).await;
        #[cfg(not(all(feature = "experimental-supervisor", target_os = "linux")))]
        return Err("supervisor unavailable".into());
    }
    #[cfg(feature = "experimental-ws")]
    return websocket_run().await;
    #[cfg(not(feature = "experimental-ws"))]
    Err("explicit supported mode required".into())
}

#[cfg(feature = "experimental-ws")]
async fn websocket_run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if !arguments
        .iter()
        .any(|argument| argument == "--experimental-ws")
    {
        return Err("explicit opt-in required".into());
    }
    let option = |name: &str| {
        arguments
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].clone())
    };
    let address = option("--listen")
        .ok_or("listener required")?
        .parse::<std::net::SocketAddr>()?;
    let upstream = option("--app-upstream");
    // App backhauls use TS authentication and preserve the public socket peer.
    if upstream.is_none() && !address.ip().is_loopback() {
        return Err("loopback listener required".into());
    }
    if let Some(upstream) = upstream {
        let backend = upstream.parse::<std::net::SocketAddr>()?;
        if !backend.ip().is_loopback() {
            return Err("loopback upstream required".into());
        }
        let key = env::var("O8D_BRIDGE_KEY")?;
        if key.is_empty() {
            return Err("bridge credential required".into());
        }
        let bus = Arc::new(EventBus::new(env::var("O8D_EPOCH")?, 400));
        let listener = TcpListener::bind(address).await?;
        println!(
            "{}",
            json!({"listening":listener.local_addr()?.to_string()})
        );
        let producer = bus.clone();
        let input = tokio::spawn(async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                producer
                    .publish(serde_json::from_str::<Vec<Value>>(&line).map_err(|_| ())?)
                    .await
                    .map_err(|_| ())?;
            }
            Ok::<(), ()>(())
        });
        let (shutdown, receiver) = tokio::sync::watch::channel(false);
        tokio::select! {
            result = o8d::app::serve(listener, upstream, key, bus, receiver) => { result?; }
            _ = input => {}
        }
        let _ = shutdown.send(true);
        // Stop accepting, close WS clients, and let already accepted HTTP
        // ingress responses drain before the supervisor reclaims the listener.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        return Ok(());
    }
    let token = env::var("WS_TOKEN")?.trim().to_owned();
    if token.is_empty() {
        return Err("credential required".into());
    }
    let initial: Vec<Value> = match option("--initial-state") {
        Some(path) => serde_json::from_slice(&std::fs::read(path)?)?,
        None => vec![],
    };
    let config = ServerConfig {
        token,
        initial,
        server_version: env::var("O8D_SERVER_VERSION")?,
        instance_id: Uuid::new_v4().to_string(),
        boot_id: Uuid::new_v4().to_string(),
    };
    let bus = Arc::new(EventBus::new(Uuid::new_v4().to_string(), 400));
    let listener = TcpListener::bind(address).await?;
    println!(
        "{}",
        json!({"listening":listener.local_addr()?.to_string()})
    );
    let producer = bus.clone();
    let input = tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        // This inherited pipe is a trusted TypeScript producer seam, never a WS client command.
        while let Ok(Some(line)) = lines.next_line().await {
            let events = serde_json::from_str::<Vec<Value>>(&line).map_err(|_| ())?;
            producer.publish(events).await.map_err(|_| ())?;
        }
        Ok::<(), ()>(())
    });
    tokio::select! {
        result = serve(listener, config, bus) => { result?; }
        result = input => { result?.map_err(|_| "invalid producer input")?; }
        _ = tokio::signal::ctrl_c() => {}
    }
    Ok(())
}
