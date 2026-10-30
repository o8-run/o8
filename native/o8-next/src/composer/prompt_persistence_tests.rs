use super::prompt_acceptance_tests::{focus, wait};
use super::*;

#[gpui::test]
fn native_composer_retry_consumes_only_context_frozen_in_its_queue_item(app: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, visual) = open(app, &fixture);
    focus(&surface, visual);
    visual.simulate_input("/recall ready");
    visual.simulate_keystrokes("enter");
    wait(&surface, visual, |s, cx| {
        !s.composer.read(cx).controls.prompt.prelude.is_empty()
    });
    let first = surface.read_with(visual, |s, cx| {
        s.composer.read(cx).controls.prompt.prelude.clone()
    });
    click("send-mode-steer", visual);
    focus(&surface, visual);
    visual.simulate_input("Fixture lose response");
    visual.simulate_keystrokes("enter");
    wait(&surface, visual, |s, _| {
        !s.saving && s.pending.contains_key("thoughts-composer-first")
    });
    focus(&surface, visual);
    visual.simulate_keystrokes("ctrl-a");
    visual.simulate_input("/recall Fixture");
    visual.simulate_keystrokes("enter");
    wait(&surface, visual, |s, cx| {
        !s.composer.read(cx).controls.busy && s.composer.read(cx).controls.prompt.prelude != first
    });
    let second = surface.read_with(visual, |s, cx| {
        s.composer
            .read(cx)
            .controls
            .prompt
            .prelude
            .strip_prefix(&format!("{first}\n\n"))
            .unwrap()
            .to_owned()
    });
    focus(&surface, visual);
    visual.simulate_keystrokes("ctrl-a");
    visual.simulate_input("Fixture lose response");
    visual.simulate_keystrokes("enter");
    wait(&surface, visual, |s, _| {
        !s.saving && !s.pending.contains_key("thoughts-composer-first")
    });
    surface.read_with(visual, |s, cx| {
        assert_eq!(
            s.composer.read(cx).controls.prompt.prelude,
            second,
            "a retry must retain context queued after the original frozen request"
        );
        let items = s.queue["items"].as_array().unwrap();
        assert_eq!(
            items.len(),
            1,
            "the retry must retain the original queue identity"
        );
        let wire = items[0]["payload"]["wireMessage"].as_str().unwrap();
        assert!(wire.contains(&first));
        assert!(!wire.contains(&second));
    });
}

#[gpui::test]
fn native_composer_recall_survives_reopen_and_is_consumed_by_a_confirmed_send(
    app: &mut TestAppContext,
) {
    let fixture = Fixture::start(true);
    let root = std::env::temp_dir().join(format!(
        "o8-prelude-store-{}-{}",
        std::process::id(),
        crate::clock::now()
    ));
    app.update(|cx| cx.set_global(crate::composer::mode_store::TestRoot(root.clone())));
    let (surface, visual) = open(app, &fixture);
    focus(&surface, visual);
    visual.simulate_input("/recall Fixture ready");
    visual.simulate_keystrokes("enter");
    wait(&surface, visual, |s, cx| {
        !s.composer.read(cx).controls.prompt.prelude.is_empty()
    });
    let path = surface.read_with(visual, |s, cx| {
        s.composer.read(cx).controls.prompt.store.clone().unwrap()
    });
    let saved = crate::composer::mode_store::load_prelude(Some(&path));
    assert!(saved.contains("Archived recall"));
    visual.update(|window, _| window.remove_window());
    drop(surface);
    let (reopened, visual) = open(app, &fixture);
    reopened.read_with(visual, |s, cx| {
        assert_eq!(s.composer.read(cx).controls.prompt.prelude, saved)
    });
    click("send-mode-steer", visual);
    focus(&reopened, visual);
    visual.simulate_input("Use recalled context");
    visual.simulate_keystrokes("enter");
    wait(&reopened, visual, |s, _| {
        !s.saving
            && s.queue["items"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
    });
    reopened.read_with(visual, |s, _| {
        assert!(
            s.queue["items"][0]["payload"]["wireMessage"]
                .as_str()
                .unwrap()
                .contains(&saved)
        )
    });
    assert_eq!(crate::composer::mode_store::load_prelude(Some(&path)), "");
    let _ = std::fs::remove_dir_all(root);
}
#[gpui::test]
fn native_composer_mode_survives_reopen_through_the_picker(app: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let root = std::env::temp_dir().join(format!(
        "o8-mode-store-{}-{}",
        std::process::id(),
        crate::clock::now()
    ));
    app.update(|cx| cx.set_global(crate::composer::mode_store::TestRoot(root.clone())));
    let (surface, visual) = open(app, &fixture);
    click("composer-mode", visual);
    click("mode-multitask", visual);
    let path = surface.read_with(visual, |s, cx| {
        s.composer.read(cx).controls.prompt.store.clone().unwrap()
    });
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "\"multitask\"");
    visual.update(|window, _| window.remove_window());
    drop(surface);
    let (reopened, visual) = open(app, &fixture);
    reopened.read_with(visual, |s, cx| {
        assert_eq!(s.composer_routing(cx).unwrap()["pickedMode"], "multitask")
    });
    click("send-mode-steer", visual);
    reopened.update_in(visual, |s, w, cx| s.composer.read(cx).focus.focus(w));
    visual.simulate_input("Restored mode");
    visual.simulate_keystrokes("enter");
    visual.run_until_parked();
    reopened.read_with(visual, |s, _| {
        assert_eq!(
            s.queue["items"][0]["payload"]["routing"]["pickedMode"],
            "multitask"
        )
    });
    let _ = std::fs::remove_dir_all(root);
}
