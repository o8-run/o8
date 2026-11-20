//! Private post-COMMIT receipt; never inferred from an HTTP success status.
use super::*;
#[derive(Clone)]
pub(crate) struct CommitNotice(pub Value);
impl CommitNotice {
    pub(super) fn new(action: &str, surface: &str) -> Option<Self> {
        if surface.is_empty() || surface.len() > 4096 {
            eprintln!("[o8d] committed notification exceeds bounds");
            return None;
        }
        Some(Self(json!({"kind":"mutation",
            "mutation":{"mutationId":uuid::Uuid::new_v4().to_string(),"source":"server","action":action,
            "status":"completed","surfaceId":surface,"createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)},
            "refreshTargets":["global"]})))
    }
}
pub(super) fn committed(response: &mut Response, action: &str, surface: &str) {
    if let Some(notice) = CommitNotice::new(action, surface) {
        response.extensions_mut().insert(notice);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_is_private_metadata_and_bounds_never_change_the_response() {
        let mut response = reply(StatusCode::CREATED, json!({"ok":true}));
        committed(&mut response, "prompt-library.create", "fixture-prompt");
        let notice = response.extensions().get::<CommitNotice>().unwrap();
        assert_eq!(notice.0["refreshTargets"], json!(["global"]));
        assert_eq!(notice.0["mutation"].as_object().unwrap().len(), 6);
        assert_eq!(response.status(), StatusCode::CREATED);
        assert!(!response.headers().contains_key("x-o8d-commit"));
        let mut large = reply(StatusCode::OK, json!({"ok":true}));
        committed(&mut large, "session-rule.add", &"x".repeat(4097));
        assert!(large.extensions().get::<CommitNotice>().is_none());
        assert_eq!(large.status(), StatusCode::OK);
    }
}
