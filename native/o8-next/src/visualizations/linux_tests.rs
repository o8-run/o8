use super::*;
#[path = "linux_headless_tests.rs"]
mod headless;
#[path = "linux_policy_tests.rs"]
mod policy;

fn reference() -> Reference {
    Reference::parse(&json!({
        "kind":"o8-visualization","id":"vis-00000000-0000-0000-0000-000000005274",
        "title":"Linux snapshot","height":320,"createdAt":"2026-11-04T00:00:00Z"
    }))
    .unwrap()
}

#[test]
fn linux_visualizations_can_start_loading() {
    let client = Client::authenticated("http://127.0.0.1:1", None).unwrap();
    let card = Card::new(reference(), client);
    assert!(card.error.is_none(), "Linux must load the sealed document");
    assert!(!card.ready);
}
