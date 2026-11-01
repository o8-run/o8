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

fn indexing_peer() -> Peer {
    let peer = Peer::new();
    peer.reply("GET", "/api/cortex/codebase-memory", 200, json!({"entries":[{"repoId":"repo-one","repoName":"Example","localPath":"/fixture/repository","status":"ready","lastIndexedAt":null}]}));
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
    peer
}
fn settled_indexing(s: &Settings) -> bool {
    !s.indexing.busy && !s.indexing.counts_busy && s.indexing.jobs.values().all(|job| !job.busy)
}

#[gpui::test]
fn settings_correction_5221_refresh_docs_updates_rendered_totals(cx: &mut TestAppContext) {
    let peer = indexing_peer();
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    click(cx, "settings-nav-indexing");
    wait(&view, cx, settled_indexing);
    assert!(
        cx.debug_bounds("settings-index-directives-value-4")
            .is_some()
    );
    peer.reply(
        "GET",
        "/api/cortex/diagnostics",
        200,
        json!({"ok":true,"directivesCount":7,"outcomesCount":7}),
    );
    click(cx, "setting-index-docs-repo-one");
    wait(&view, cx, settled_indexing);
    assert!(
        cx.debug_bounds("settings-index-directives-value-7")
            .is_some(),
        "document refresh must refresh the rendered Brain total"
    );
    assert_eq!(
        peer.calls()
            .iter()
            .filter(|(m, p, _)| m == "GET" && p == "/api/cortex/diagnostics")
            .count(),
        2
    );

    let calls = peer.calls();
    let post = calls
        .iter()
        .position(|(m, p, _)| m == "POST" && p == "/api/cortex/reingest")
        .unwrap();
    let totals = calls
        .iter()
        .rposition(|(m, p, _)| m == "GET" && p == "/api/cortex/diagnostics")
        .unwrap();
    assert!(
        totals > post,
        "totals must be fetched after the confirmed document write"
    );

    peer.reply("GET", "/api/cortex/diagnostics", 503, json!({}));
    click(cx, "setting-index-docs-repo-one");
    wait(&view, cx, settled_indexing);
    assert!(
        view.read_with(cx, |s, _| !s.indexing.jobs["repo-one"].failed
            && s.indexing.counts.is_none()
            && s.indexing.counts_error)
    );
    assert!(
        cx.debug_bounds("settings-index-directives-value-Unavailable")
            .is_some(),
        "a failed totals read cannot retain the old count after successful ingestion"
    );

    peer.reply(
        "GET",
        "/api/cortex/diagnostics",
        200,
        json!({"ok":true,"directivesCount":11,"outcomesCount":7}),
    );
    click(cx, "setting-indexing-refresh");
    wait(&view, cx, settled_indexing);
    assert!(
        cx.debug_bounds("settings-index-directives-value-11")
            .is_some()
    );
    for (status, body) in [
        (200, json!({"ok":true})),
        (
            200,
            json!({"ok":false,"result":{"writtenDirectives":99,"scannedFiles":99}}),
        ),
        (503, json!({})),
    ] {
        peer.reply("POST", "/api/cortex/reingest", status, body);
        click(cx, "setting-index-docs-repo-one");
        wait(&view, cx, settled_indexing);
        assert!(view.read_with(cx, |s, _| {
            s.indexing.jobs["repo-one"].failed
                && s.indexing.jobs["repo-one"]
                    .note
                    .as_ref()
                    .is_some_and(|note| note.contains("Could not confirm"))
        }));
    }
    peer.reply(
        "POST",
        "/api/cortex/reingest",
        200,
        json!({"ok":true,"result":{"writtenDirectives":1,"scannedFiles":2}}),
    );
    peer.reply(
        "GET",
        "/api/cortex/diagnostics",
        200,
        json!({"ok":true,"directivesCount":12,"outcomesCount":7}),
    );
    click(cx, "setting-index-docs-repo-one");
    wait(&view, cx, settled_indexing);
    assert!(view.read_with(cx, |s, _| !s.indexing.jobs["repo-one"].failed));
    assert!(
        cx.debug_bounds("settings-index-directives-value-12")
            .is_some()
    );
    assert!(
        peer.calls()
            .iter()
            .filter(|(m, _, _)| m == "POST")
            .all(|(_, p, body)| p == "/api/cortex/reingest"
                && body == &json!({"repoPath":"/fixture/repository"}))
    );
}

#[gpui::test]
fn settings_correction_5221_revisit_refreshes_rendered_totals(cx: &mut TestAppContext) {
    let peer = indexing_peer();
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    click(cx, "settings-nav-indexing");
    wait(&view, cx, settled_indexing);
    assert!(
        cx.debug_bounds("settings-index-directives-value-4")
            .is_some()
    );
    click(cx, "settings-nav-general");
    wait(&view, cx, |_| true);
    peer.reply(
        "GET",
        "/api/cortex/diagnostics",
        200,
        json!({"ok":true,"directivesCount":19,"outcomesCount":7}),
    );
    click(cx, "settings-nav-indexing");
    wait(&view, cx, settled_indexing);
    assert!(
        cx.debug_bounds("settings-index-directives-value-19")
            .is_some(),
        "revisiting Indexing must replace the cached total"
    );
}
