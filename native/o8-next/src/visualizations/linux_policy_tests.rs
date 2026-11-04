use super::*;
use crate::visualizations::{
    linux::{Request, Response},
    linux_renderer::{parse, Navigation},
};
use base64::{engine::general_purpose::STANDARD, Engine};

#[test]
fn linux_navigation_has_only_single_use_bootstrap_permits() {
    let forbidden = [
        "https://example.invalid",
        "http://127.0.0.1:1",
        "file:///tmp/document",
        "data:text/html,blocked",
        "blob:blocked",
        "about:blank#later",
        "about:srcdoc#later",
    ];
    let mut policy = Navigation::new();
    for uri in forbidden {
        assert!(!policy.allow(uri, true, false), "{uri}");
    }
    assert!(!policy.allow("about:blank", false, false));
    assert!(!policy.allow("about:blank", true, true));
    assert!(!policy.allow("about:srcdoc", true, false));
    assert!(policy.allow("about:blank", true, false));
    assert!(policy.allow("about:blank", true, false));
    assert!(!policy.allow("about:blank", true, false));
    assert!(policy.allow("about:srcdoc", true, false));
    for uri in forbidden.into_iter().chain(["about:blank", "about:srcdoc"]) {
        assert!(!policy.allow(uri, true, false), "later navigation: {uri}");
    }
    // Some WebKit versions omit the inert blank iframe's policy callback.
    let mut policy = Navigation::new();
    assert!(policy.allow("about:blank", true, false));
    assert!(policy.allow("about:srcdoc", true, false));
    assert!(!policy.allow("about:blank", true, false));
    let mut policy = Navigation::new();
    assert!(policy.allow("about:blank", true, false));
    policy.close();
    assert!(!policy.allow("about:blank", true, false));
    assert!(!policy.allow("about:srcdoc", true, false));
}

#[test]
fn linux_relay_uses_the_shared_bounded_display_grammar() {
    let nonce = "linux-fixture-0123456789";
    let height = json!({"type":"o8-visualization:height","nonce":nonce,"height":175.2});
    assert!(matches!(
        parse(&height.to_string(), nonce),
        Some(Message::Height(176.))
    ));
    assert!(parse(&height.to_string(), "different").is_none());
    for value in [
        json!({"type":"o8-visualization:question","nonce":nonce,"value":"act"}),
        json!({"type":"o8-visualization:height","nonce":nonce,"height":"176"}),
        json!({"type":"o8-visualization:state","nonce":nonce,"value":{"prototype":{}}}),
        json!({"type":"o8-visualization:state","nonce":nonce,"value":{"x":"x".repeat(25000)}}),
        json!({"type":"o8-visualization:state","nonce":nonce,"value":[]}),
    ] {
        assert!(parse(&value.to_string(), nonce).is_none());
    }
    assert!(parse("not JSON", nonce).is_none());
    let state = json!({"type":"o8-visualization:state","nonce":nonce,"value":{"week":2}});
    assert!(
        matches!(parse(&state.to_string(),nonce),Some(Message::State(value)) if value["week"]==2)
    );
}

#[test]
fn linux_pipe_inputs_and_pictures_are_bounded() {
    let mut request = Request {
        document: "<p>fixture</p>".into(),
        nonce: "linux-fixture-0123456789".into(),
        width: 728,
        height: 320.,
        theme: json!({"colorScheme":"dark"}),
        state: json!({}),
    };
    assert!(request.valid());
    request.width = 0;
    assert!(!request.valid());
    request.width = 1601;
    assert!(!request.valid());
    request.width = 728;
    request.state = json!({"constructor":{}});
    assert!(!request.valid());
    request.state = json!({});
    request.height = f64::INFINITY;
    assert!(!request.valid());
    let surface = cairo::ImageSurface::create(cairo::Format::ARgb32, 728, 176).unwrap();
    let mut png = Vec::new();
    surface.write_to_png(&mut png).unwrap();
    let mut response = Response {
        height: 176.,
        state: Some(json!({"week":2})),
        png: STANDARD.encode(&png),
    };
    assert_eq!(response.picture(728).unwrap(), png);
    assert!(response.picture(480).is_err());
    response.height = 177.;
    assert!(response.picture(728).is_err());
    response.height = 176.2;
    assert!(response.picture(728).is_err());
    response.height = 176.;
    response.state = Some(json!([]));
    assert!(response.picture(728).is_err());
    response.state = None;
    response.png = "invalid".into();
    assert!(response.picture(728).is_err());
}
