use super::*;

fn make<'a>(
    cx: &'a mut TestAppContext,
    workspace: &'static str,
    saved: Option<&str>,
) -> (Entity<Picker<Owned>>, &'a mut gpui::VisualTestContext) {
    let client = Client::new("http://127.0.0.1:9").unwrap();
    let saved = saved.map(str::to_owned);
    cx.add_window_view(|_, cx| Picker::<Owned>::new(client, workspace.into(), saved, cx))
}

fn opened(picker: &Entity<Picker<Owned>>, cx: &gpui::VisualTestContext, expected: &str) {
    picker.read_with(cx, |picker, cx| {
        assert_eq!(picker.selected.as_deref(), Some(expected), "workspace {}", picker.workspace);
        assert_eq!(
            picker.child.as_ref().map(|child| child.read(cx).0.as_str()),
            Some(expected)
        );
    });
}

fn listed(picker: &Entity<Picker<Owned>>, cx: &gpui::VisualTestContext) {
    picker.read_with(cx, |picker, _| {
        assert!(
            picker.child.is_none() && picker.selected.is_none(),
            "explicit list stays open"
        );
        assert!(!picker.loading);
    });
}

fn key(picker: &Entity<Picker<Owned>>, cx: &mut gpui::VisualTestContext, keys: &str) {
    picker.update_in(cx, |picker, window, cx| press(picker, keys, window, cx));
    paint(cx);
}

fn click(cx: &mut gpui::VisualTestContext, selector: &'static str) {
    let bounds = cx.debug_bounds(selector).expect(selector);
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    paint(cx);
}

fn initial_creation_and_saved_choices_use_the_real_picker(cx: &mut TestAppContext) {
    for (workspace, saved, listed_ids, expected) in [
        ("initial-empty", None, vec![], "own-shell"),
        (
            "initial-owned-saved",
            Some("own-shell"),
            vec![],
            "own-shell",
        ),
        (
            "initial-stale-saved",
            Some("gone"),
            vec![("other", "other")],
            "own-shell",
        ),
        (
            "initial-valid-saved",
            Some("other"),
            vec![("other", "other")],
            "other",
        ),
        (
            "initial-listed-own",
            None,
            vec![("own-shell", "own-shell")],
            "own-shell",
        ),
    ] {
        configure(
            workspace,
            vec![Some(Ok("own-shell".into()))],
            vec![Ok(listed_ids)],
        );
        let (picker, visual) = make(cx, workspace, saved);
        paint(visual);
        opened(&picker, visual, expected);
        assert_eq!(calls(workspace), (1, 1));
        picker.read_with(visual, |picker, _| {
            assert_eq!(
                picker
                    .choices
                    .iter()
                    .filter(|c| c.id == "own-shell")
                    .count(),
                1
            );
        });
        visual.update(|window, _| window.remove_window());
    }
}

fn failure_keeps_valid_saved_target_but_never_opens_a_missing_one(cx: &mut TestAppContext) {
    for (workspace, saved, expected) in [
        ("failure-no-saved", None, None),
        ("failure-valid-saved", Some("other"), Some("other")),
        ("failure-stale-saved", Some("gone"), None),
    ] {
        configure(
            workspace,
            vec![Some(Err("refused".into()))],
            vec![Ok(vec![("other", "other")])],
        );
        let (picker, visual) = make(cx, workspace, saved);
        paint(visual);
        if let Some(id) = expected {
            opened(&picker, visual, id);
        } else {
            listed(&picker, visual);
        }
        picker.read_with(visual, |picker, _| {
            assert_eq!(picker.own_error(), Some("refused"))
        });
        assert_eq!(calls(workspace).0, 1);
        visual.update(|window, _| window.remove_window());
    }
}

fn retry_button_and_f5_survive_repeated_failures(cx: &mut TestAppContext) {
    for (workspace, first_button) in [("retry-button-first", true), ("retry-f5-first", false)] {
        queue(
            workspace,
            vec![
                Err("first".into()),
                Err("second".into()),
                Ok("own-shell".into()),
            ],
        );
        let (picker, visual) = make(cx, workspace, None);
        paint(visual);
        listed(&picker, visual);
        if first_button {
            click(visual, "target-own-retry");
        } else {
            key(&picker, visual, "f5");
        }
        listed(&picker, visual);
        assert_eq!(calls(workspace).0, 2);
        picker.read_with(visual, |picker, _| {
            assert_eq!(picker.own_error(), Some("second"))
        });
        if first_button {
            key(&picker, visual, "f5");
        } else {
            click(visual, "target-own-retry");
        }
        opened(&picker, visual, "own-shell");
        assert_eq!(calls(workspace).0, 3);
        visual.update(|window, _| window.remove_window());
    }
}

fn pending_refreshes_coalesce_without_losing_success_or_failure(cx: &mut TestAppContext) {
    for (workspace, fail) in [("pending-success", false), ("pending-failure", true)] {
        queue(
            workspace,
            if fail {
                vec![Err("refused".into()), Ok("own-shell".into())]
            } else {
                vec![Ok("own-shell".into())]
            },
        );
        let client = Client::new("http://127.0.0.1:9").unwrap();
        let (picker, visual) = cx.add_window_view(|window, cx| {
            let mut picker = Picker::<Owned>::new(client, workspace.into(), None, cx);
            for _ in 0..3 {
                press(&mut picker, "f5", window, cx);
            }
            picker
        });
        paint(visual);
        assert_eq!(
            calls(workspace),
            (1, 4),
            "refresh must never duplicate pending creation"
        );
        if fail {
            listed(&picker, visual);
            picker.read_with(visual, |picker, _| {
                assert_eq!(picker.own_error(), Some("refused"))
            });
            key(&picker, visual, "f5");
            assert_eq!(calls(workspace).0, 2);
        }
        opened(&picker, visual, "own-shell");
        visual.update(|window, _| window.remove_window());
    }
}

fn list_intent_survives_pending_refreshes_and_repeated_reopen(cx: &mut TestAppContext) {
    for (workspace, fail) in [
        ("pending-list-success", false),
        ("pending-list-failure", true),
    ] {
        queue(
            workspace,
            if fail {
                vec![Err("refused".into()), Ok("own-shell".into())]
            } else {
                vec![Ok("own-shell".into())]
            },
        );
        let client = Client::new("http://127.0.0.1:9").unwrap();
        let (picker, visual) = cx.add_window_view(|window, cx| {
            let mut picker = Picker::<Owned>::new(client, workspace.into(), None, cx);
            for chord in ["ctrl-alt-o", "f5", "cmd-alt-o", "f5"] {
                press(&mut picker, chord, window, cx);
            }
            picker
        });
        paint(visual);
        listed(&picker, visual);
        assert_eq!(calls(workspace), (1, 5));
        key(&picker, visual, "ctrl-alt-o");
        listed(&picker, visual);
        assert_eq!(
            calls(workspace).0,
            1,
            "listing after error must never retry creation"
        );
        key(&picker, visual, "f5");
        if fail {
            opened(&picker, visual, "own-shell");
            assert_eq!(calls(workspace).0, 2);
        } else {
            listed(&picker, visual);
            assert_eq!(
                calls(workspace).0,
                1,
                "refresh after success stays on the list"
            );
        }
        visual.update(|window, _| window.remove_window());
    }
}

fn list_reopen_keeps_error_and_the_retry_button_usable(cx: &mut TestAppContext) {
    queue(
        "list-error-button",
        vec![Err("refused".into()), Ok("own-shell".into())],
    );
    let (picker, visual) = make(cx, "list-error-button", None);
    paint(visual);
    for chord in ["ctrl-alt-o", "cmd-alt-o"] {
        key(&picker, visual, chord);
        listed(&picker, visual);
        picker.read_with(visual, |picker, _| {
            assert_eq!(picker.own_error(), Some("refused"))
        });
        assert_eq!(calls("list-error-button").0, 1);
    }
    click(visual, "target-own-retry");
    opened(&picker, visual, "own-shell");
    assert_eq!(calls("list-error-button").0, 2);
}

fn cancelled_retry_failure_is_retained_for_the_next_retry(cx: &mut TestAppContext) {
    queue(
        "cancelled-retry",
        vec![
            Err("first".into()),
            Err("second".into()),
            Ok("own-shell".into()),
        ],
    );
    let (picker, visual) = make(cx, "cancelled-retry", None);
    paint(visual);
    picker.update_in(visual, |picker, window, cx| {
        for chord in ["f5", "ctrl-alt-o", "f5"] {
            press(picker, chord, window, cx);
        }
    });
    paint(visual);
    listed(&picker, visual);
    assert_eq!(calls("cancelled-retry").0, 2);
    picker.read_with(visual, |picker, _| {
        assert_eq!(picker.own_error(), Some("second"))
    });
    key(&picker, visual, "f5");
    opened(&picker, visual, "own-shell");
    assert_eq!(calls("cancelled-retry").0, 3);
}

fn successful_creation_survives_inventory_failure_and_retry(cx: &mut TestAppContext) {
    for (workspace, saved, expected) in [
        ("inventory-failed-none", None, "own-shell"),
        ("inventory-failed-saved", Some("other"), "other"),
    ] {
        configure(
            workspace,
            vec![Some(Ok("own-shell".into()))],
            vec![Err("inventory down".into())],
        );
        let (picker, visual) = make(cx, workspace, saved);
        paint(visual);
        picker.read_with(visual, |picker, _| {
            assert!(picker.failed && picker.child.is_none())
        });
        inventory(workspace, Ok(vec![("other", "other")]));
        click(visual, "target-retry");
        opened(&picker, visual, expected);
        assert_eq!(
            calls(workspace),
            (1, 2),
            "a successful own result must be retained"
        );
        visual.update(|window, _| window.remove_window());
    }
}

fn list_command_cancels_restore_even_when_inventory_is_down(cx: &mut TestAppContext) {
    configure(
        "inventory-list",
        vec![Some(Ok("own-shell".into()))],
        vec![Err("inventory down".into())],
    );
    let (picker, visual) = make(cx, "inventory-list", Some("other"));
    paint(visual);
    key(&picker, visual, "ctrl-alt-o");
    inventory("inventory-list", Ok(vec![("other", "other")]));
    click(visual, "target-retry");
    listed(&picker, visual);
    assert_eq!(calls("inventory-list").0, 1);
    key(&picker, visual, "f5");
    listed(&picker, visual);
    assert_eq!(calls("inventory-list").0, 1);
}

fn creation_failure_is_retained_when_inventory_also_fails(cx: &mut TestAppContext) {
    configure(
        "both-failed",
        vec![
            Some(Err("creation refused".into())),
            Some(Ok("own-shell".into())),
        ],
        vec![Err("inventory down".into())],
    );
    let client = Client::new("http://127.0.0.1:9").unwrap();
    let (picker, visual) = cx.add_window_view(|window, cx| {
        let mut picker = Picker::<Owned>::new(client, "both-failed".into(), None, cx);
        press(&mut picker, "f5", window, cx);
        picker
    });
    paint(visual);
    picker.read_with(visual, |picker, _| {
        assert!(picker.failed);
        assert_eq!(picker.own_error(), Some("creation refused"));
    });
    assert!(visual.debug_bounds("target-own-error").is_some());
    assert_eq!(calls("both-failed").0, 1);
    inventory("both-failed", Ok(vec![]));
    click(visual, "target-retry");
    opened(&picker, visual, "own-shell");
    assert_eq!(calls("both-failed").0, 2);
}

fn ports_without_an_own_target_restore_saved_choice_and_only_refresh_inventory(
    cx: &mut TestAppContext,
) {
    for (workspace, saved) in [
        ("no-own-saved", Some("other")),
        ("no-own-stale", Some("gone")),
        ("no-own-empty", None),
    ] {
        configure(workspace, vec![None], vec![Ok(vec![("other", "other")])]);
        let (picker, visual) = make(cx, workspace, saved);
        paint(visual);
        if saved == Some("other") {
            opened(&picker, visual, "other");
        } else {
            listed(&picker, visual);
        }
        key(&picker, visual, "ctrl-alt-o");
        key(&picker, visual, "f5");
        listed(&picker, visual);
        assert_eq!(calls(workspace), (1, 3));
        picker.read_with(visual, |picker, _| assert_eq!(picker.own_error(), None));
        visual.update(|window, _| window.remove_window());
    }
}

fn manual_selection_wins_over_pending_creation_success_and_failure(cx: &mut TestAppContext) {
    cx.background_executor.deprioritize(*OWN_REQUEST);
    for (workspace, mouse, fail) in [
        ("manual-key-success", false, false),
        ("manual-mouse-success", true, false),
        ("manual-key-failure", false, true),
        ("manual-mouse-failure", true, true),
    ] {
        configure(
            workspace,
            vec![Some(if fail {
                Err("refused".into())
            } else {
                Ok("own-shell".into())
            })],
            vec![Ok(vec![("other", "other")])],
        );
        let client = Client::new("http://127.0.0.1:9").unwrap();
        let handle = cx.add_window(|window, cx| {
            let mut picker = Picker::<Owned>::new(client, workspace.into(), None, cx);
            press(&mut picker, "ctrl-alt-o", window, cx);
            picker
        });
        let picker = handle.root(cx).unwrap();
        // add_window_view drains all tasks before returning, including held ones.
        // Build the same real window without that implicit drain for this race.
        let mut visual = gpui::VisualTestContext::from_window(*std::ops::Deref::deref(&handle), cx);
        let visual = &mut visual;
        // GPUI's labelled executor holds only own creation. Drain the actual
        // inventory callbacks one task at a time, without fabricated picker state.
        while picker.read_with(visual, |picker, _| picker.loading) {
            assert!(visual.background_executor.tick());
        }
        assert_eq!(calls(workspace).0, 0, "creation is still pending");
        visual.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        if mouse {
            let bounds = visual.debug_bounds("target-0").unwrap();
            // The platform helper releases background work between down/up.
            // A repaint may cancel that gesture; it must never adopt the own
            // shell, and a fresh click on the settled row must remain usable.
            visual.simulate_mouse_down(
                bounds.center(), gpui::MouseButton::Left, gpui::Modifiers::default(),
            );
            listed(&picker, visual);
            visual.simulate_mouse_up(
                bounds.center(), gpui::MouseButton::Left, gpui::Modifiers::default(),
            );
            if picker.read_with(visual, |picker, _| picker.selected.is_none()) {
                paint(visual);
                let bounds = visual.debug_bounds("target-0").unwrap();
                visual.simulate_click(bounds.center(), gpui::Modifiers::default());
            }
        } else {
            picker.update_in(visual, |picker, window, cx| {
                press(picker, "enter", window, cx)
            });
        }
        opened(&picker, visual, "other");
        paint(visual);
        opened(&picker, visual, "other");
        assert_eq!(calls(workspace).0, 1);
        let generation = picker.read_with(visual, |picker, _| picker.generation);
        key(&picker, visual, "f5");
        assert_eq!(
            picker.read_with(visual, |picker, _| picker.generation),
            generation,
            "F5 belongs to an attached child"
        );
        visual.update(|window, _| window.remove_window());
    }
}

fn cached_own_choice_can_be_selected_without_creation_or_automatic_adoption(
    cx: &mut TestAppContext,
) {
    configure(
        "cached-own-list",
        vec![Some(Ok("own-shell".into()))],
        vec![Ok(vec![("other", "other")])],
    );
    let (picker, visual) = make(cx, "cached-own-list", None);
    paint(visual);
    opened(&picker, visual, "own-shell");
    key(&picker, visual, "ctrl-alt-o");
    key(&picker, visual, "f5");
    listed(&picker, visual);
    visual.simulate_keystrokes("o w n enter");
    paint(visual);
    opened(&picker, visual, "own-shell");
    assert_eq!(calls("cached-own-list").0, 1);
}

fn second_picker_reuses_owner_but_each_view_keeps_its_own_list_intent(cx: &mut TestAppContext) {
    queue(
        "two-views",
        vec![Ok("own-shell".into()), Ok("own-shell".into())],
    );
    let (first, visual_a) = make(cx, "two-views", None);
    paint(visual_a);
    opened(&first, visual_a, "own-shell");
    let (second, visual_b) = make(&mut visual_a.cx, "two-views", Some("own-shell"));
    paint(visual_b);
    opened(&second, visual_b, "own-shell");
    assert_eq!(calls("two-views").0, 2);
    key(&second, visual_b, "ctrl-alt-o");
    listed(&second, visual_b);
    first.read_with(visual_b, |picker, cx| {
        assert_eq!(picker.selected.as_deref(), Some("own-shell"));
        assert_eq!(picker.child.as_ref().unwrap().read(cx).0, "own-shell");
    });
}

#[gpui::test(iterations = 20)]
fn own_shell_state_machine_preserves_results_and_explicit_intent(cx: &mut TestAppContext) {
    pending_refreshes_coalesce_without_losing_success_or_failure(cx);
    initial_creation_and_saved_choices_use_the_real_picker(cx);
    failure_keeps_valid_saved_target_but_never_opens_a_missing_one(cx);
    retry_button_and_f5_survive_repeated_failures(cx);
    list_intent_survives_pending_refreshes_and_repeated_reopen(cx);
    list_reopen_keeps_error_and_the_retry_button_usable(cx);
    cancelled_retry_failure_is_retained_for_the_next_retry(cx);
    successful_creation_survives_inventory_failure_and_retry(cx);
    list_command_cancels_restore_even_when_inventory_is_down(cx);
    creation_failure_is_retained_when_inventory_also_fails(cx);
    ports_without_an_own_target_restore_saved_choice_and_only_refresh_inventory(cx);
    manual_selection_wins_over_pending_creation_success_and_failure(cx);
    cached_own_choice_can_be_selected_without_creation_or_automatic_adoption(cx);
    second_picker_reuses_owner_but_each_view_keeps_its_own_list_intent(cx);
}
