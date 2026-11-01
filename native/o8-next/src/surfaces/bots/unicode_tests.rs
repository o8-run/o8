//! Decode production bot HTTP responses with the actual native client.
use super::*;

fn configure_unicode(fixture: &Fixture, value: Value) {
    let url = fixture.client.url("/__fixture/bots").unwrap();
    assert_eq!(
        fixture
            .client
            .request("POST", &url)
            .send_json(json!({"unicode": value}))
            .unwrap()
            .status(),
        200
    );
}

#[test]
fn bots_unicode_mailbox_caps_decode_through_the_native_http_client() {
    let fixture = Fixture::start_mode(false, "--bots");
    for (text, expected) in [
        ("x".repeat(20_001), "x".repeat(20_000)),
        (
            format!("{}😀", "x".repeat(19_998)),
            format!("{}😀", "x".repeat(19_998)),
        ),
        (format!("{}😀", "x".repeat(19_999)), "x".repeat(19_999)),
    ] {
        configure_unicode(&fixture, json!({"text":text}));
        let body = fixture
            .client
            .bot_thread("grok:agent-1")
            .expect("a valid producer string must remain decodable after capping");
        assert_eq!(body.messages.len(), 1);
        assert_eq!(body.messages[0].id, "unicode-source");
        assert_eq!(body.messages[0].text, expected);
    }
}

#[test]
fn bots_unicode_configured_and_grok_names_decode_through_the_native_http_client() {
    let fixture = Fixture::start_mode(false, "--bots");
    for (name, expected) in [
        ("x".repeat(81), "x".repeat(80)),
        (
            format!("{}😀", "x".repeat(78)),
            format!("{}😀", "x".repeat(78)),
        ),
        (format!("{}😀", "x".repeat(79)), "x".repeat(79)),
    ] {
        configure_unicode(&fixture, json!({"name":name}));
        let bots = fixture
            .client
            .bots()
            .expect("configured and provider names must remain decodable after capping");
        assert_eq!(bots.len(), 2);
        assert!(bots.iter().all(|bot| bot.name == expected));
    }
}
