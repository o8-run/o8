//! Private post-COMMIT receipt; never inferred from an HTTP success status.
use super::*;
#[derive(Clone)]
pub(crate) struct CommitNotice(pub Value);
impl CommitNotice {
    /// Composer's legacy mutation contract has a desktop source and a repo
    /// target. Keep it separate from the six-key server notices below.
    pub(crate) fn composer(id: &str, thread: &str, repo: &str, now: i64) -> Option<Self> {
        if thread.starts_with("wsi:") {
            return None;
        }
        let created = chrono::DateTime::from_timestamp_millis(now)?;
        let value = json!({"kind":"mutation","refreshTargets":["global"],"mutation":{
            "mutationId":format!("composer-queue-{id}-{now}"),"source":"desktop",
            "action":"composer-queue","status":"completed","surfaceId":thread,
            "repoPath":repo,"createdAt":created.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}});
        // Leave room for the private native-commit envelope and realtime epoch.
        if !std::path::Path::new(repo).is_absolute() || value.to_string().len() > 15 * 1024 {
            eprintln!("[o8d] committed notification exceeds bounds");
            return None;
        }
        Some(Self(value))
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    fn committed(response: &mut Response, action: &str, surface: &str) {
        if let Some(notice) = CommitNotice::new(action, surface) {
            response.extensions_mut().insert(notice);
        }
    }
    #[test]
    fn composer_notice_matches_the_locked_seven_key_desktop_variant() {
        let notice = CommitNotice::composer("fixture-id", "thoughts-fixture", "/fixture", 1234)
            .unwrap()
            .0;
        assert_eq!(
            notice,
            json!({"kind":"mutation","refreshTargets":["global"],"mutation":{
            "mutationId":"composer-queue-fixture-id-1234","source":"desktop","action":"composer-queue",
            "status":"completed","surfaceId":"thoughts-fixture","repoPath":"/fixture",
            "createdAt":"1970-01-01T00:00:01.234Z"}})
        );
        assert_eq!(notice.as_object().unwrap().len(), 3);
        assert_eq!(notice["mutation"].as_object().unwrap().len(), 7);
        assert!(CommitNotice::composer("fixture-id", "wsi:fixture", "/fixture", 1234).is_none());
        assert!(
            CommitNotice::composer("fixture-id", "thoughts-fixture", "relative", 1234).is_none()
        );
    }
    #[test]
    fn receipt_is_private_metadata_and_bounds_never_change_the_response() {
        let mut response = reply(StatusCode::CREATED, json!({"ok":true}));
        committed(&mut response, "session-rule.add", "fixture-thread");
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
