use super::*;
use crate::settings::test_peer::*;
use gpui::TestAppContext;

#[gpui::test]
fn settings_parity_indexing_refresh_docs_and_independent_counts(cx: &mut TestAppContext) {
    let peer = Peer::new();
    peer.reply("GET", "/api/cortex/codebase-memory", 200, json!({"entries":[{"repoId":"repo-one","repoName":"Example","localPath":"/fixture/repository","status":"ready","lastIndexedAt":"2026-10-31T12:00:00Z"}]}));
    peer.reply(
        "GET",
        "/api/cortex/diagnostics",
        200,
        json!({"ok":true,"directivesCount":4,"outcomesCount":7}),
    );
    peer.reply(
        "POST",
        "/api/cortex/reingest",
        200,
        json!({"ok":true,"result":{"writtenDirectives":3,"scannedFiles":10}}),
    );
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    click(cx, "settings-nav-indexing");
    wait(&view, cx, |s| {
        !s.indexing.busy && !s.indexing.counts_busy && s.indexing.entries.is_some()
    });
    click(cx, "setting-index-docs-repo-one");
    wait(&view, cx, |s| {
        s.indexing.jobs.get("repo-one").is_some_and(|job| !job.busy)
    });
    assert_eq!(
        peer.calls()
            .into_iter()
            .find(|(method, _, _)| method == "POST")
            .unwrap()
            .2,
        json!({"repoPath":"/fixture/repository"})
    );
    assert!(view.read_with(cx, |s, _| {
        s.indexing.jobs["repo-one"]
            .note
            .as_deref()
            .is_some_and(|note| note.contains("3 sections"))
    }));
    peer.reply("GET", "/api/cortex/codebase-memory", 503, json!({}));
    click(cx, "setting-indexing-refresh");
    wait(&view, cx, |s| !s.indexing.busy && !s.indexing.counts_busy);
    assert!(view.read_with(cx, |s, _| s.indexing.error.is_some()
        && s.indexing.counts.as_ref().unwrap().directives_count == Some(4)));
    peer.reply(
        "GET",
        "/api/cortex/codebase-memory",
        200,
        json!({"entries":[]}),
    );
    peer.reply("GET", "/api/cortex/diagnostics", 503, json!({}));
    click(cx, "setting-indexing-refresh");
    wait(&view, cx, |s| !s.indexing.busy && !s.indexing.counts_busy);
    assert!(view.read_with(cx, |s, _| s.indexing.error.is_none()
        && s.indexing.counts.is_none()));
}
