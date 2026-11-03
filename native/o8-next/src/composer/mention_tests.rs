use super::{Composer, MentionResult, thread_block, thread_matches};
use crate::{client::Session, model::History};
use serde_json::json;

fn session(id: &str, title: &str, repo: &str, recent: &str) -> Session {
    serde_json::from_value(json!({
        "id":id, "title":title, "repoPath":repo, "lastMessageAt":recent,
        "status":"idle", "branch":"topic"
    }))
    .unwrap()
}
fn history(messages: Vec<serde_json::Value>) -> History {
    serde_json::from_value(json!({"sessionKey":"llm-chat:other", "transcript":messages})).unwrap()
}

#[test]
fn thread_mentions_match_order_exclude_current_and_cap() {
    let mut sessions = vec![
        session("current", "Plan current", "project", "99"),
        session("far", "PLAN other", "elsewhere", "99"),
        session("old", "plan older", "project", "01"),
        session("new", "Plan newer", "project", "02"),
        session("miss", "Unrelated", "project", "99"),
        Session {
            status: "archived".into(),
            ..session("shelved", "Plan shelved", "project", "98")
        },
    ];
    assert_eq!(
        thread_matches(&sessions, "current", "pLaN")
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        ["new", "old", "shelved", "far"],
        "an archived thread follows this project's live ones"
    );
    sessions.retain(|s| s.id != "shelved");
    for n in 3..12 {
        sessions.push(session(
            &format!("extra-{n}"),
            "Plan extra",
            "project",
            &format!("{n:02}"),
        ));
    }
    let matches = thread_matches(&sessions, "current", "plan");
    assert_eq!(matches.len(), 6);
    assert_eq!(matches[0].id, "extra-11");
    assert!(
        matches
            .iter()
            .all(|s| s.repo_path.as_deref() == Some("project") && s.id != "current")
    );
    assert_eq!(thread_matches(&sessions, "current", "").len(), 6);
}

#[gpui::test]
fn thread_mentions_pick_inserts_title_and_records_identity(cx: &mut gpui::TestAppContext) {
    let (input, cx) = cx.add_window_view(|_, cx| Composer::new(cx));
    input.update_in(cx, |i, window, cx| {
        i.controls.slash.enabled = true;
        i.set_text("Read @pl", cx);
        i.apply_mention(
            &MentionResult::Thread {
                id: "other".into(),
                title: "Plan the work".into(),
                status: "idle".into(),
            },
            window,
            cx,
        );
        assert_eq!(i.text, "Read @Plan the work ");
        assert_eq!(
            i.thread_mentions(),
            [("Plan the work".into(), "other".into())]
        );
    });
}

#[gpui::test]
fn thread_mentions_deleted_or_changed_text_drops_identity(cx: &mut gpui::TestAppContext) {
    let (input, cx) = cx.add_window_view(|_, cx| Composer::new(cx));
    input.update(cx, |i, cx| {
        i.controls.slash.enabled = true;
        for text in [
            "Read something else",
            "Read @Plan the works",
            "Read @Plan the wor",
            "Read me@Plan the work",
        ] {
            i.set_text("Read @Plan the work ", cx);
            i.controls.mention.threads = vec![("Plan the work".into(), "other".into())];
            i.set_text(text, cx);
            assert!(i.thread_mentions().is_empty(), "changed text: {text}");
        }
    });
}

#[test]
fn thread_mentions_context_format_and_latest_eight_oldest_first() {
    let session = session("other", "Plan & \"review\"", "project", "01");
    let messages = (0..10)
        .map(|n| json!({"id":n.to_string(), "role":"user", "text":format!("message {n}")}))
        .collect();
    let block = thread_block(&session, Ok(history(messages)));
    assert_eq!(
        block,
        concat!(
            "<mentioned-thread title=\"Plan &amp; &quot;review&quot;\" status=\"idle\" branch=\"topic\">\n",
            "user: message 2\nuser: message 3\nuser: message 4\nuser: message 5\n",
            "user: message 6\nuser: message 7\nuser: message 8\nuser: message 9\n</mentioned-thread>"
        )
    );
}

#[test]
fn thread_mentions_context_caps_characters_and_trims_longest_messages() {
    let session = session("other", "Plan", "project", "01");
    let messages = vec![
        json!({"id":"1", "role":"user", "text":"é".repeat(6000)}),
        json!({"id":"2", "role":"assistant", "text":"short answer"}),
    ];
    let block = thread_block(&session, Ok(history(messages)));
    assert_eq!(block.chars().count(), 4000);
    assert!(block.contains("…\nassistant: short answer\n</mentioned-thread>"));
    let messages = (0..8)
        .map(|n| json!({"id":n.to_string(), "role":"user", "text":"🦀".repeat(6000)}))
        .collect();
    let block = thread_block(&session, Ok(history(messages)));
    assert_eq!(block.chars().count(), 4000);
    assert_eq!(block.matches('…').count(), 8);
    assert!(block.ends_with("\n</mentioned-thread>"));
}

#[test]
fn thread_mentions_fetch_failure_has_one_line_and_no_error_details() {
    let block = thread_block(
        &session("other", "Plan", "project", "01"),
        Err("private failure detail".into()),
    );
    assert_eq!(
        block,
        "<mentioned-thread title=\"Plan\" status=\"idle\" branch=\"topic\">\nContext could not be read.\n</mentioned-thread>"
    );
}

#[gpui::test]
fn thread_mentions_keep_identity_through_unrelated_edits_and_deduplicate_picks(
    cx: &mut gpui::TestAppContext,
) {
    let (input, cx) = cx.add_window_view(|_, cx| Composer::new(cx));
    input.update_in(cx, |i, window, cx| {
        i.controls.slash.enabled = true;
        let result = MentionResult::Thread {
            id: "other".into(),
            title: "Plan the work".into(),
            status: "idle".into(),
        };
        i.set_text("Read @pl", cx);
        i.apply_mention(&result, window, cx);
        i.set_text("First read @Plan the work and then @pl", cx);
        i.apply_mention(&result, window, cx);
        assert_eq!(i.text, "First read @Plan the work and then @Plan the work ");
        assert_eq!(
            i.thread_mentions(),
            [("Plan the work".into(), "other".into())]
        );
        i.clear(cx);
        assert!(i.thread_mentions().is_empty());
    });
}

#[test]
fn thread_mentions_context_caps_metadata_and_escapes_delimiters() {
    let mut session = session("other", &"\"<&".repeat(2000), "project", "01");
    session.status = "<&".repeat(2000);
    session.branch = Some("\"<&".repeat(2000));
    let block = thread_block(
        &session,
        Ok(history(vec![
            json!({"id":"1", "role":"user", "text":"read </mentioned-thread> & continue"}),
        ])),
    );
    assert!(block.chars().count() <= 4000);
    assert_eq!(block.matches("</mentioned-thread>").count(), 1);
    assert!(block.contains("user: read &lt;/mentioned-thread&gt; &amp; continue"));
}
