//! Real composer command and Client transport, driven by the isolated socket fixture.
use super::*;

#[test]
#[ignore = "driven by the product session-rule fixture with Node stopped"]
fn session_rules_without_node() {
    let root = std::path::PathBuf::from(std::env::var_os("O8_SESSION_RULE_CLIENT_DATA").unwrap());
    assert_eq!(
        std::fs::read_to_string(root.join("fixture-owner")).unwrap(),
        "o8d-native-read/v1"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("node-stopped")).unwrap(),
        "stopped"
    );
    let token = std::fs::read_to_string(root.join("ws-token")).unwrap();
    let client = Client::authenticated(
        &std::env::var("O8_SESSION_RULE_CLIENT_ORIGIN").unwrap(),
        Some(token.trim().to_owned()),
    )
    .unwrap();
    let route = "/api/orchestrator/session-rules";
    let read = || {
        client
            .get::<Value>(route, &[("threadId", "thoughts-review")])
            .unwrap()
    };
    let state = root.join("session-rule-client-state.json");
    if !state.exists() {
        let before = read();
        let session: Session = serde_json::from_value(json!({"id":"thoughts-review", "title":"Fixture", "status":"idle", "repoPath":root.join("fixture-repo")})).unwrap();
        let result = super::command_client::run(
            &client,
            &session,
            "/rule",
            "composer native rule",
            &[],
            &Value::Null,
        )
        .unwrap();
        assert_eq!(result.feedback, "Session rule added.");
        let after = read();
        let old = before["result"]["rules"].as_array().unwrap();
        let rules = after["result"]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), old.len() + 1);
        assert_eq!(&rules[..old.len()], old.as_slice());
        assert_eq!(rules.last().unwrap()["text"], "composer native rule");
        assert!(
            client
                .get::<Value>(route, &[])
                .unwrap_err()
                .contains("HTTP 400")
        );
        std::fs::write(
            state,
            serde_json::to_vec(
                &json!({"before":before,"after":after,"id":rules.last().unwrap()["id"]}),
            )
            .unwrap(),
        )
        .unwrap();
    } else {
        let saved: Value = serde_json::from_slice(&std::fs::read(state).unwrap()).unwrap();
        assert_eq!(
            read(),
            saved["after"],
            "restart must retain exact rule ordering and values"
        );
        // Same request/read path used by the composer rule removal control.
        let mut url = client.url(route).unwrap();
        url.query_pairs_mut()
            .append_pair("id", saved["id"].as_str().unwrap());
        let removed: Value = Client::read(client.request("DELETE", &url).call().unwrap()).unwrap();
        assert_eq!(removed, json!({"ok":true,"result":{"removed":true}}));
        assert_eq!(read(), saved["before"]);
    }
}
