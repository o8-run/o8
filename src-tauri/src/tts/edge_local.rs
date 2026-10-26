//! Free neural male voice via the bundled server's /api/tts (edge-tts →
//! en-US-SteffanNeural — the Mister reading voice).
//!
//! The Rust read-back chain was ElevenLabs (premium key) → Google (key) →
//! macOS `say`, which on a keyless FREE machine skipped every neural voice and
//! landed on the system default — a woman's voice, nothing like the product's
//! (operator report 2026-07-12, free MacBook, read-back chord). The node side
//! has always had the free Steffan voice for the play button; this bridges the
//! Rust chain to it over loopback (which passes the API gate by design) so
//! keyless machines read back in the same voice as everyone else. Failure here
//! still falls through to `say` — the always-works floor.

const STEFFAN_VOICE: &str = "en-US-SteffanNeural";

/// Synthesize `text` → MP3 bytes via the local /api/tts route. Errors are
/// `String`, matching the sibling providers.
pub async fn synthesize(text: &str) -> Result<Vec<u8>, String> {
    let port = crate::resolve_api_port();
    let url = format!("http://127.0.0.1:{port}/api/tts");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("edge-local client: {e}"))?;
    // Attach the ws-token bearer: /api/tts is behind the default-deny middleware
    // gate, and the loopback-socket heuristic does NOT reliably pass a Rust
    // server-side POST — without the token this 401s and Steffan silently falls
    // through to the macOS `say` floor, defeating the free-voice default
    // (adversarial review 2026-07-15, same class as the o8 free-rail 401).
    let token = crate::agent::o8_http::ws_token();
    let mut req = client
        .post(&url)
        .json(&serde_json::json!({ "text": text, "voice": STEFFAN_VOICE }));
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("edge-local request: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.json::<serde_json::Value>().await.ok();
        let code = body.as_ref().and_then(|body| body.get("code")?.as_str());
        return Err(super::edge_voice_error::response_error(
            status.as_str(),
            code,
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("edge-local body: {e}"))?;
    if bytes.is_empty() {
        return Err("edge-local returned empty audio".to_string());
    }
    Ok(bytes.to_vec())
}
