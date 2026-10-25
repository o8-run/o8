//! Opt-in MCP transport shared by o8d and the compatibility binary. Native reads
//! are passive; TypeScript remains the authority for every other tool.
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use reqwest::{redirect::Policy, Client, Url};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::net::TcpListener;

mod native_reads;
mod projections;
const READ_TOOLS: &[&str] = &[
    "o8_status",
    "get_mission_status",
    "o8_task_list",
    "o8_list_repos",
    "o8_list_projects",
    "o8_lease_list",
    "o8_lease_status",
    "o8_spec_read",
];

#[derive(Clone)]
pub struct McpServer {
    upstream: Url,
    client: Client,
    native_reads: Option<std::sync::Arc<native_reads::NativeReads>>,
}
impl McpServer {
    pub fn new(upstream: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let upstream = Url::parse(upstream)?;
        // Local source only; redirects must never forward credentials elsewhere.
        if upstream.scheme() != "http"
            || !matches!(upstream.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
            || upstream.port().is_none()
            || upstream.path() != "/"
            || upstream.query().is_some()
            || !upstream.username().is_empty()
            || upstream.password().is_some()
            || upstream.fragment().is_some()
        {
            return Err("explicit loopback HTTP upstream required".into());
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(180))
            .build()?;
        Ok(Self {
            upstream,
            client,
            native_reads: None,
        })
    }
    pub fn with_native_reads(
        mut self,
        directory: std::path::PathBuf,
        database: Option<std::path::PathBuf>,
    ) -> Self {
        self.native_reads = Some(std::sync::Arc::new(native_reads::NativeReads::new(
            directory, database,
        )));
        self
    }
    async fn request(
        &self,
        method: Method,
        path: &str,
        headers: &HeaderMap,
        body: Bytes,
    ) -> Result<reqwest::Response, reqwest::Error> {
        let mut url = self.upstream.clone();
        let (path, query) = path
            .split_once('?')
            .map_or((path, None), |(p, q)| (p, Some(q)));
        url.set_path(path);
        url.set_query(query);
        let mut request = self.client.request(method, url).body(body);
        // Strip hop-by-hop/framing headers; never synthesize an operator bearer.
        for (name, value) in headers {
            if !matches!(
                name.as_str(),
                "host"
                    | "content-length"
                    | "connection"
                    | "transfer-encoding"
                    | "upgrade"
                    | "keep-alive"
                    | "te"
                    | "trailer"
                    | "proxy-authorization"
            ) {
                request = request.header(name, value);
            }
        }
        request.send().await
    }
    async fn proxy(&self, method: Method, headers: &HeaderMap, body: Bytes) -> Response {
        match self.request(method, "/api/mcp", headers, body).await {
            Ok(response) => relay(response).await,
            Err(_) => unavailable(),
        }
    }
    async fn catalog(&self, headers: &HeaderMap, body: Bytes) -> Response {
        match self.request(Method::POST, "/api/mcp", headers, body).await {
            Ok(response) => relay_body(response, true).await,
            Err(_) => unavailable(),
        }
    }
    async fn source(&self, path: &str, headers: &HeaderMap) -> Result<Value, ()> {
        let mut headers = headers.clone();
        headers.insert("x-o8-agent-tool", "1".parse().unwrap());
        let response = self
            .request(Method::GET, path, &headers, Bytes::new())
            .await
            .map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        response.json().await.map_err(|_| ())
    }
    async fn tool(
        &self,
        name: &str,
        args: &Value,
        headers: &HeaderMap,
        status_source: Option<&Value>,
    ) -> Result<Value, ()> {
        // Keep the TS path expansion contract for tilde paths and unusual inputs.
        if name == "o8_status"
            && args
                .get("sessionKey")
                .is_some_and(|value| !value.is_string() && !value.is_null())
        {
            return Err(());
        }
        if serde_json::to_string(args).map_err(|_| ())?.contains("~") {
            return Err(());
        }
        let data = match name {
            "o8_status" => {
                let source = status_source.ok_or(())?;
                if source.get("data").is_none()
                    || source.get("runtimeConnections").is_none()
                    || source.get("snapshot").is_none()
                {
                    return Err(());
                }
                projections::status(
                    source["data"].clone(),
                    source["runtimeConnections"].clone(),
                    source["snapshot"].clone(),
                    args,
                )
            }
            "get_mission_status" => {
                let path = query(
                    "/api/orchestrator/status",
                    args,
                    &["missionId"],
                    &["includeCost", "includeTiming"],
                );
                let response = self.source(&path, headers).await?;
                if response["ok"] != true || response.get("result").is_none() {
                    return Err(());
                }
                response["result"].clone()
            }
            "o8_task_list" => {
                let path = query(
                    "/api/tasks",
                    args,
                    &["projectId", "repoPath"],
                    &["includeDone", "includeBrief"],
                );
                let response = self.source(&path, headers).await?;
                projections::tasks(response, args)
            }
            "o8_list_repos" => projections::repos(self.source("/api/panel/repos", headers).await?),
            "o8_list_projects" => {
                projections::projects(self.source("/api/panel/projects", headers).await?)
            }
            "o8_lease_list" => self.source("/api/leases", headers).await?,
            "o8_lease_status" => {
                args["resource"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or(())?;
                self.source(&query("/api/leases", args, &["resource"], &[]), headers)
                    .await?
            }
            "o8_spec_read" => {
                args["repoPath"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or(())?;
                self.source(&query("/api/repo-spec", args, &["repoPath"], &[]), headers)
                    .await?
            }
            _ => return Err(()),
        };
        Ok(
            json!({"isError": data.get("error").is_some(), "content": [{"type":"text", "text": serde_json::to_string(&data).map_err(|_| ())?}]}),
        )
    }
}

fn query(path: &str, args: &Value, strings: &[&str], booleans: &[&str]) -> String {
    let mut serializer = reqwest::Url::parse("http://fixture.invalid").unwrap();
    {
        let mut pairs = serializer.query_pairs_mut();
        for key in strings {
            if let Some(value) = args[*key]
                .as_str()
                .map(|value| {
                    if *key == "sessionKey" {
                        value
                    } else {
                        value.trim()
                    }
                })
                .filter(|value| !value.is_empty())
            {
                pairs.append_pair(key, value);
            }
        }
        for key in booleans {
            if args[*key] == true {
                pairs.append_pair(key, "true");
            }
        }
    }
    match serializer.query().filter(|q| !q.is_empty()) {
        Some(q) => format!("{path}?{q}"),
        None => path.into(),
    }
}

fn response(status: StatusCode, body: Value) -> Response {
    (
        status,
        [("content-type", "application/json")],
        body.to_string(),
    )
        .into_response()
}
fn unavailable() -> Response {
    response(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"error":"o8d MCP upstream unavailable"}),
    )
}
async fn relay(upstream: reqwest::Response) -> Response {
    relay_body(upstream, false).await
}
async fn relay_body(upstream: reqwest::Response, catalog: bool) -> Response {
    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    for name in [
        "content-length",
        "connection",
        "transfer-encoding",
        "keep-alive",
    ] {
        headers.remove(name);
    }
    match upstream.bytes().await {
        Ok(body) => {
            if catalog
                && status == StatusCode::OK
                && serde_json::from_slice::<Value>(&body).is_err()
            {
                return unavailable();
            }
            (status, headers, body).into_response()
        }
        Err(_) => unavailable(),
    }
}
fn native(message: &Value) -> bool {
    match message["method"].as_str() {
        Some("initialize" | "tools/list") => true,
        Some("tools/call") => message["params"]["name"]
            .as_str()
            .is_some_and(|name| READ_TOOLS.contains(&name)),
        // Unknown methods retain the existing transport semantics.
        _ => false,
    }
}

async fn handle(
    State(server): State<McpServer>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if method != Method::POST {
        return server.proxy(method, &headers, body).await;
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return server.proxy(method, &headers, body).await,
    };
    let batch = payload.is_array();
    let messages = payload
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![payload.clone()]);
    // Modern protocol metadata and mirrored routing headers are validated by
    // the shared TypeScript host. Native projections retain legacy envelopes;
    // forward modern requests intact until they implement that contract too.
    if headers.contains_key("mcp-protocol-version")
        || headers.contains_key("mcp-method")
        || headers.contains_key("mcp-name")
        || messages.iter().any(|message| {
            message["params"]["_meta"]
                .get("io.modelcontextprotocol/protocolVersion")
                .is_some()
                || message["params"]["_meta"]
                    .get("io.modelcontextprotocol/clientCapabilities")
                    .is_some()
        })
    {
        return server.proxy(method, &headers, body).await;
    }
    // A mixed batch is forwarded byte for byte, once, so mutations keep ordering,
    // correlation ids, notifications and all existing TypeScript side effects.
    if messages.is_empty() || messages.iter().any(|message| !native(message)) {
        return server.proxy(method, &headers, body).await;
    }
    // The registry and its field order belong to TypeScript. Relay the complete
    // catalog exchange, including batches, without reconstructing any JSON.
    if messages
        .iter()
        .any(|message| message["method"] == "tools/list")
    {
        return server.catalog(&headers, body).await;
    }
    let initialize = messages
        .iter()
        .any(|message| message["method"] == "initialize");
    if let Some(reader) = server.native_reads.as_ref().filter(|_| {
        !initialize
            && messages
                .iter()
                .all(|message| message["method"] == "tools/call")
    }) {
        // Read-only batches can safely retry through the original entry point.
        // No partial native result is returned on an unsupported source or error.
        let mut result = reader.read(&server.upstream, &headers, &messages);
        if result.is_err() {
            if let Some(generation) = reader.pending_generation() {
                // Bind the live publisher to this upstream once per generation,
                // using the caller's credential, never an ambient operator token.
                let context =
                    json!({"jsonrpc":"2.0","id":"o8d-native-bind","method":"o8d/read-context"});
                let upstream = match server
                    .request(
                        Method::POST,
                        "/api/mcp",
                        &headers,
                        Bytes::from(context.to_string()),
                    )
                    .await
                {
                    Ok(value) => value,
                    Err(_) => return unavailable(),
                };
                if !upstream.status().is_success() {
                    return relay(upstream).await;
                }
                if let Ok(context) = upstream.json::<Value>().await {
                    if context["result"]["nativeGeneration"] == generation {
                        reader.verify_generation(generation);
                        result = reader.read(&server.upstream, &headers, &messages);
                    }
                }
            }
        }
        match result {
            Ok(mut results) => {
                return if results.is_empty() {
                    (StatusCode::ACCEPTED, [("content-type", "application/json")]).into_response()
                } else {
                    response(
                        StatusCode::OK,
                        if batch {
                            json!(results)
                        } else {
                            results.remove(0)
                        },
                    )
                }
            }
            Err(()) => return server.proxy(method, &headers, body).await,
        }
    }
    let status_requests: Vec<Value> = messages.iter().enumerate().filter(|(_, message)| message["method"] == "tools/call" && message["params"]["name"] == "o8_status" && !message["id"].is_null() && !batch)
        .map(|(index, message)| json!({"index": index, "arguments":message["params"].get("arguments").cloned().unwrap_or(json!({}))})).collect();
    let context = json!({"jsonrpc":"2.0","id":"o8d-context","method":"o8d/read-context","params":{"statusRequests":status_requests}});
    let upstream = match server
        .request(
            Method::POST,
            "/api/mcp",
            &headers,
            Bytes::from(context.to_string()),
        )
        .await
    {
        Ok(value) => value,
        Err(_) => return unavailable(),
    };
    if !upstream.status().is_success() {
        return relay(upstream).await;
    }
    let context: Value = match upstream.json().await {
        Ok(value) => value,
        Err(_) => return unavailable(),
    };
    let tools = match context["result"]["tools"].as_array() {
        Some(tools) => tools,
        None => return server.proxy(method, &headers, body).await,
    };
    let profile = context["result"]["profile"].as_str().unwrap_or("full");
    let mut responses = Vec::new();
    for (index, message) in messages.into_iter().enumerate() {
        let id = &message["id"];
        if id.is_null() {
            continue;
        }
        let result = if message["method"] == "initialize" {
            json!({"protocolVersion":"2024-11-05", "capabilities":{"tools":{}},
                "serverInfo":{"name":"o8-operator","version":"1.0.0"}})
        } else {
            let name = message["params"]["name"].as_str().unwrap_or("");
            if !tools.iter().any(|tool| tool["name"] == name) {
                json!({"isError":true,"content":[{"type":"text","text":format!("Tool unavailable in operator MCP profile {profile}: {name}")}]})
            } else {
                let args = message["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                // Path expansion and error/retry policy remain authoritative in TS.
                // Fall back only for this read, never replay a mutating batch.
                // Preserve sequential batch semantics: a fresh read must finish
                // before the next cached status read or another read's reconciliation.
                let refreshed_context = if batch && name == "o8_status" {
                    let request = json!({"jsonrpc":"2.0","id":"o8d-context","method":"o8d/read-context","params":{"statusRequests":[{"index":index,"arguments":args}]}});
                    let upstream = match server
                        .request(
                            Method::POST,
                            "/api/mcp",
                            &headers,
                            Bytes::from(request.to_string()),
                        )
                        .await
                    {
                        Ok(value) => value,
                        Err(_) => return unavailable(),
                    };
                    if !upstream.status().is_success() {
                        return relay(upstream).await;
                    }
                    match upstream.json::<Value>().await {
                        Ok(value) => Some(value),
                        Err(_) => return unavailable(),
                    }
                } else {
                    None
                };
                let read_context = refreshed_context.as_ref().unwrap_or(&context);
                let status_source = read_context["result"]["statusSources"]
                    .as_array()
                    .and_then(|sources| sources.iter().find(|source| source["index"] == index))
                    .and_then(|source| source.get("source"));
                match server.tool(name, &args, &headers, status_source).await {
                    Ok(value) => value,
                    Err(_) => {
                        let original = Bytes::from(message.to_string());
                        let upstream = match server
                            .request(Method::POST, "/api/mcp", &headers, original)
                            .await
                        {
                            Ok(value) => value,
                            Err(_) => return unavailable(),
                        };
                        if !upstream.status().is_success() {
                            return relay(upstream).await;
                        }
                        let value: Value = match upstream.json().await {
                            Ok(value) => value,
                            Err(_) => return unavailable(),
                        };
                        responses.push(value);
                        continue;
                    }
                }
            }
        };
        responses.push(json!({"jsonrpc":"2.0","id":id,"result":result}));
    }
    let mut output = if responses.is_empty() {
        (StatusCode::ACCEPTED, [("content-type", "application/json")]).into_response()
    } else {
        response(
            StatusCode::OK,
            if batch {
                json!(responses)
            } else {
                responses.remove(0)
            },
        )
    };
    if initialize {
        output.headers_mut().insert(
            "mcp-session-id",
            uuid::Uuid::new_v4().to_string().parse().unwrap(),
        );
    }
    output
}

pub async fn serve(listener: TcpListener, server: McpServer) -> std::io::Result<()> {
    axum::serve(
        listener,
        Router::new()
            .route("/api/mcp", any(handle))
            .with_state(server)
            // Match the upstream transport rather than axum's default 2 MiB limit.
            .layer(axum::extract::DefaultBodyLimit::disable()),
    )
    .await
}

pub async fn run(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if !arguments.iter().any(|arg| arg == "--experimental-mcp") {
        return Err("explicit opt-in required".into());
    }
    let option = |name: &str| {
        arguments
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].clone())
    };
    let address: std::net::SocketAddr = option("--listen").ok_or("listener required")?.parse()?;
    if !address.ip().is_loopback() {
        return Err("loopback listener required".into());
    }
    let upstream = option("--upstream").ok_or("upstream required")?;
    let mut server = McpServer::new(&upstream)?;
    if arguments.iter().any(|arg| arg == "--native-reads") {
        let directory =
            std::path::PathBuf::from(option("--data-dir").ok_or("data directory required")?);
        if !directory.is_absolute() {
            return Err("absolute data directory required".into());
        }
        let database = std::env::var_os("CORTEX_IDE_DB_PATH").map(std::path::PathBuf::from);
        server = server.with_native_reads(directory, database);
    }
    let listener = TcpListener::bind(address).await?;
    println!(
        "{}",
        json!({"listening": listener.local_addr()?.to_string()})
    );
    tokio::select! {
        result = serve(listener, server) => { result?; }
        _ = tokio::signal::ctrl_c() => {}
    }
    Ok(())
}
