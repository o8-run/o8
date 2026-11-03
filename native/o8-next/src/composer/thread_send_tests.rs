use super::prompt_acceptance_tests::*;
use super::*;

fn send_mentioned_thread(cx: &mut TestAppContext, mode: &str) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    let origin = surface.read_with(cx, |s, _| s.selected.clone());
    surface.update(cx, |s, cx| {
        let mentioned = s
            .sessions
            .iter_mut()
            .find(|s| s.id == "thoughts-composer-second")
            .unwrap();
        mentioned.title = "Earlier work".into();
        mentioned.branch = Some("topic".into());
        s.queue["canSteer"] = json!(true);
        s.composer.update(cx, |i, cx| {
            i.set_text("Read @Earlier work ", cx);
            i.controls.mention.threads =
                vec![("Earlier work".into(), "thoughts-composer-second".into())];
        });
        match mode {
            "queue" => s.queue_prompt(cx),
            "fork" => s.fork_prompt(cx),
            _ => s.send(None, cx),
        }
    });
    wait(&surface, cx, |s, cx| {
        assert!(
            s.notice.is_empty() || s.saving || mode != "fork",
            "fork: {}",
            s.notice
        );
        assert!(
            s.composer.read(cx).controls.error.is_empty(),
            "{}",
            s.composer.read(cx).controls.error
        );
        !s.saving
            && s.queue["items"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
    });
    surface.read_with(cx, |s, _| {
        let item = s.queue["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["payload"]["text"] == "Read @Earlier work")
            .expect("saved draft");
        let steers: Value = fixture
            .client
            .get("/api/composer-steer-fixture", &[])
            .unwrap();
        let wire = if item["intent"] == "steer-now" {
            assert_eq!(item["status"], "applied");
            steers[0].as_str().expect("admitted dispatch")
        } else {
            item["payload"]["wireMessage"].as_str().unwrap()
        };
        assert!(
            wire.contains("<mentioned-thread title=\"Earlier work\""),
            "wire: {wire}"
        );
        assert!(wire.contains("branch=\"topic\""));
        assert!(wire.contains("assistant: Fixture ready\n</mentioned-thread>"));
        if mode != "fork" {
            assert_eq!(
                item["intent"],
                if mode == "steer" {
                    "steer-now"
                } else {
                    "send-next"
                }
            );
        }
        if mode == "fork" {
            assert_ne!(s.selected, origin);
        }
        let queue = fixture
            .client
            .queue(
                s.sessions
                    .iter()
                    .find(|session| Some(&session.id) == s.selected.as_ref())
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            queue["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|saved| saved["id"] == item["id"])
                .unwrap()["payload"]["wireMessage"],
            item["payload"]["wireMessage"]
        );
    });
}

#[gpui::test]
fn thread_mentions_queue_delivers_history_through_saved_queue(cx: &mut TestAppContext) {
    send_mentioned_thread(cx, "queue");
}
#[gpui::test]
fn thread_mentions_steer_delivers_history_through_saved_queue(cx: &mut TestAppContext) {
    send_mentioned_thread(cx, "steer");
}
#[gpui::test]
fn thread_mentions_fork_carries_identity_and_delivers_history(cx: &mut TestAppContext) {
    send_mentioned_thread(cx, "fork");
}

#[gpui::test]
fn thread_mentions_menu_search_and_click_insert_visible_title(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    surface.update(cx, |s, _| {
        s.sessions
            .iter_mut()
            .find(|s| s.id == "thoughts-composer-second")
            .unwrap()
            .title = "Earlier work".into();
    });
    focus(&surface, cx);
    cx.simulate_input("Read @earLIer");
    wait(&surface, cx, |s, cx| {
        s.composer
            .read(cx)
            .mention_suggestions()
            .iter()
            .any(|result| {
                matches!(
                    result,
                    crate::composer::mention::MentionResult::Thread { .. }
                )
            })
    });
    wait_selector(cx, "mention-0");
    assert!(cx.debug_bounds("mention-group-threads").is_some());
    click("mention-0", cx);
    surface.update_in(cx, |s, window, cx| {
        assert!(s.composer.read(cx).focus.is_focused(window));
        s.composer.update(cx, |i, _| {
            assert_eq!(i.text, "Read @Earlier work ");
            assert_eq!(
                i.thread_mentions(),
                [("Earlier work".into(), "thoughts-composer-second".into())]
            );
        });
    });
}

#[gpui::test]
fn thread_mentions_failed_history_read_still_delivers_the_message(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    assert!(fixture.client.history("unavailable:context").is_err());
    surface.update(cx, |s, cx| {
        let mut mentioned = s
            .sessions
            .iter()
            .find(|s| s.id == "thoughts-composer-second")
            .unwrap()
            .clone();
        mentioned.id = "unavailable:context".into();
        mentioned.title = "Unavailable context".into();
        s.sessions.push(mentioned);
        s.composer.update(cx, |i, cx| {
            i.set_text("Read @Unavailable context ", cx);
            i.controls.mention.threads =
                vec![("Unavailable context".into(), "unavailable:context".into())];
        });
        s.queue_prompt(cx);
    });
    wait(&surface, cx, |s, _| {
        !s.saving
            && s.queue["items"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
    });
    surface.read_with(cx, |s, _| {
        let wire = s.queue["items"][0]["payload"]["wireMessage"]
            .as_str()
            .unwrap();
        assert!(
            wire.contains("<mentioned-thread title=\"Unavailable context\""),
            "wire: {wire}"
        );
        assert!(wire.ends_with("Context could not be read.\n</mentioned-thread>"));
    });
}
