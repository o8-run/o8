//! In-process composer dictation through the production shell: a fake speech
//! helper (crate::speech::fake) and the fixture host's composer queue and
//! polish peer.
use super::*;
use crate::shell::test_support::*;
use crate::speech::fake::Fake;
use crate::ui::{DictationState, VoiceState};

#[gpui::test]
fn native_dictation_fills_the_draft_polishes_and_sends(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--voice-host");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("native-dictation.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let helper = Fake::new("shell");
    let launch = helper.launch(&[("FAKE_FINAL", "check the build")]);
    shell.update_in(&mut visual, |s, _, _| s.use_speech_helper(launch));
    let (first, second) = ("thoughts-composer-first", "thoughts-composer-second");
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Session(first.into()), window, cx)
    });
    ready(&shell, &mut visual);
    let view = shell.read_with(&visual, |s, _| {
        match s.content.get(&s.key(&s.active().unwrap())) {
            Some(Content::Session(view)) => view.clone(),
            _ => panic!("session"),
        }
    });
    view.update(&mut visual, |view, cx| view.dictate("Draft:", cx));
    let mic = |visual: &mut VisualTestContext| view.read_with(visual, |view, _| view.dictation());
    let draft = |visual: &mut VisualTestContext| view.read_with(visual, |view, cx| view.draft(cx));
    let notice = |visual: &mut VisualTestContext| {
        shell.read_with(visual, |s, cx| {
            crate::shell::toasts::texts(cx)
                .last()
                .cloned()
                .unwrap_or_else(|| s.notice.clone())
        })
    };
    let host = |key: &str| {
        fixture
            .client
            .get::<Value>("/api/next/voice-host", &[])
            .unwrap()[key]
            .clone()
    };
    // The helper runs on its own threads; wait for its updates to land.
    let until = |visual: &mut VisualTestContext,
                 what: &str,
                 done: &dyn Fn(&mut VisualTestContext) -> bool| {
        for _ in 0..500 {
            visual.run_until_parked();
            if done(visual) {
                draw(visual);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!(
            "{what}; mic {:?}, draft {:?}, notice {:?}",
            mic(visual),
            draft(visual),
            notice(visual)
        );
    };
    // With a draft the primary button is Send, so dictation runs through the
    // mic action, as the hotkey does.
    let tap = |visual: &mut VisualTestContext| {
        visual
            .update(|window, cx| window.dispatch_action(Box::new(crate::ui::ToggleDictation), cx));
        visual.run_until_parked();
        draw(visual);
    };

    // A tap starts the helper; its snapshots replace what follows the draft.
    tap(&mut visual);
    until(&mut visual, "listening with partial text", &|visual| {
        mic(visual) == DictationState::Listening && draft(visual) == "Draft: hello world"
    });
    assert_eq!(host("controls"), json!([]), "the voice host is not used");

    // The next tap stops; Apple's final text is polished by the server and
    // goes out through the chat's own queue.
    tap(&mut visual);
    let repo = view
        .read_with(&visual, |view, cx| view.voice_binding(cx))
        .unwrap()
        .repo;
    let queued = |visual: &mut VisualTestContext| {
        visual.run_until_parked();
        let queue: Value = fixture
            .client
            .get(
                "/api/orchestrator/composer-queue",
                &[("repoPath", &repo), ("threadId", first)],
            )
            .unwrap();
        queue["items"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|item| item["payload"]["text"] == "Draft: Check the build.")
    };
    until(&mut visual, "the polished text was sent", &|visual| {
        queued(visual) && mic(visual) == DictationState::Off
    });
    assert_eq!(
        host("polishes"),
        json!([{"transcript": "check the build", "surface": "chat",
            "context": {"activeRepoPath": repo}}])
    );

    // While dictation holds the microphone, Live does not start.
    let before = draft(&mut visual);
    tap(&mut visual);
    until(&mut visual, "listening again", &|visual| {
        mic(visual) == DictationState::Listening && draft(visual).ends_with("hello world")
    });
    shell.update_in(&mut visual, |s, _, cx| s.toggle_voice(cx));
    visual.run_until_parked();
    assert_eq!(notice(&mut visual), "Another voice input is active.");
    assert_eq!(
        view.read_with(&visual, |view, _| view.voice()),
        VoiceState::Off
    );
    assert_eq!(host("controls"), json!([]), "Live sent no start");

    // Opening another chat mid-recording cancels it and puts the draft back.
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Session(second.into()), window, cx);
        s.tick(false, window, cx);
    });
    visual.run_until_parked();
    assert_eq!(mic(&mut visual), DictationState::Off);
    assert_eq!(draft(&mut visual), before);
    // A late final for the cancelled recording sends nothing.
    std::thread::sleep(std::time::Duration::from_millis(200));
    visual.run_until_parked();
    assert_eq!(host("polishes").as_array().map(Vec::len), Some(1));
}
