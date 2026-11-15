//! Actual Inbox navigation on GPUI's headless platform; no simulated input.
use super::*;
use gpui::TestAppContext;

#[gpui::test]
fn native_approval_audit_log_is_reachable(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:9", Some("fixture".into())).unwrap();
    let (_, cx) = cx.add_window_view(|_, cx| Inbox::new(client, String::new(), cx));
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("inbox-view-audit").is_some(),
        "Approval audit history must be reachable from Inbox"
    );
}
