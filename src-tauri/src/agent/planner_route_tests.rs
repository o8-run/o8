//! Unit coverage for the planner registry. The REAL-path counterparts — tool
//! dispatch and the spawned argv per adapter — live in `planner_seat_tests.rs`.

use super::*;
use serde_json::json;

#[test]
fn bound_effort_pins_survive_every_catalog_model() {
    for model in claude().pinnable_models {
        for effort in ["low", "medium", "high", "xhigh"] {
            let seat = selected(resolve_bound_with(claude().id, model, effort, all_installed));
            assert_eq!(seat.effort, effort, "bound effort changed for {model}");
        }
    }
}

fn all_installed(adapter: &PlannerAdapter) -> Option<String> {
    Some(format!("/mock/{}", adapter.binary))
}

/// Only the named adapters resolve a binary.
fn installed(ids: &'static [&'static str]) -> impl FnMut(&PlannerAdapter) -> Option<String> {
    move |adapter: &PlannerAdapter| {
        ids.contains(&adapter.id)
            .then(|| format!("/mock/{}", adapter.binary))
    }
}

fn auto() -> BrainSetting {
    BrainSetting::default()
}

fn chose(provider: &str) -> BrainSetting {
    BrainSetting {
        provider: Some(provider.to_string()),
        ..BrainSetting::default()
    }
}

fn selected(routing: PlannerRouting) -> PlannerSelection {
    match routing {
        PlannerRouting::Selected(selection) => selection,
        PlannerRouting::Unavailable { message } => panic!("expected a seat, got {message}"),
    }
}

fn claude() -> &'static PlannerAdapter {
    adapter_by_id("claude").unwrap()
}

fn codex() -> &'static PlannerAdapter {
    adapter_by_id("codex").unwrap()
}

#[test]
fn no_pin_never_seats_the_frontier_orchestrator_model() {
    for preferred in [claude(), codex()] {
        let selection = selected(resolve_with(&auto(), preferred, all_installed));
        assert_ne!(
            selection.model.as_deref(),
            Some(crate::models::CLAUDE_FABLE_5),
            "the background planner must never default to the frontier orchestrator id"
        );
        assert_ne!(
            selection.model.as_deref(),
            Some(crate::models::CLAUDE_OPUS_4_8)
        );
    }
}

#[test]
fn default_tiers_are_sonnet_flag_free_and_codex_sol_high() {
    let claude_seat = selected(resolve_with(&auto(), claude(), all_installed));
    assert_eq!(claude_seat.provider.id, "claude");
    assert_eq!(
        claude_seat.model.as_deref(),
        Some(crate::models::CLAUDE_SONNET_5)
    );
    assert_eq!(claude_seat.effort, "medium");
    // The Claude worker tier is spawned WITHOUT an `--effort` flag; only the
    // builder tier carries one.
    assert_eq!(claude_effort_flag(crate::models::CLAUDE_SONNET_5), None);
    assert_eq!(
        claude_effort_flag(BUILDER_CLAUDE_PLANNER_MODEL),
        Some("high")
    );
    assert_eq!(claude_effort_flag(crate::models::CLAUDE_FABLE_5), Some("high"));

    let codex_seat = selected(resolve_with(&auto(), codex(), all_installed));
    assert_eq!(codex_seat.provider.id, "codex");
    assert_eq!(
        codex_seat.model.as_deref(),
        Some(DEFAULT_CODEX_PLANNER_MODEL)
    );
    assert_eq!(codex_seat.effort, "high");
    assert_eq!(codex_planner_effort(WORKER_CODEX_PLANNER_MODEL), "medium");
}

/// The two-entry route the registry replaced, reimplemented as an oracle: the
/// unset default must still agree with it everywhere it resolved a seat.
fn legacy_route(
    preferred: &str,
    installed: &[&str],
) -> Option<(&'static str, &'static str, &'static str)> {
    let order = if preferred == "claude" {
        ["claude", "codex"]
    } else {
        ["codex", "claude"]
    };
    order.into_iter().find(|id| installed.contains(id)).map(|id| {
        if id == "claude" {
            ("claude", crate::models::CLAUDE_SONNET_5, "medium")
        } else {
            ("codex", DEFAULT_CODEX_PLANNER_MODEL, "high")
        }
    })
}

#[test]
fn the_unset_default_still_resolves_exactly_what_the_two_cli_route_did() {
    const SUBSETS: [&[&str]; 8] = [
        &[],
        &["claude"],
        &["codex"],
        &["opencode"],
        &["claude", "codex"],
        &["claude", "opencode"],
        &["codex", "opencode"],
        &["claude", "codex", "opencode"],
    ];
    for preferred in [claude(), codex()] {
        for subset in SUBSETS {
            let routing = resolve_with(&auto(), preferred, |adapter: &PlannerAdapter| {
                subset
                    .contains(&adapter.id)
                    .then(|| format!("/mock/{}", adapter.binary))
            });
            match legacy_route(preferred.id, subset) {
                // Wherever the old route seated a planner, the registry seats
                // the same provider, model and effort.
                Some((provider, model, effort)) => {
                    let selection = selected(routing);
                    assert_eq!(selection.provider.id, provider, "{preferred:?} {subset:?}");
                    assert_eq!(selection.model.as_deref(), Some(model), "{subset:?}");
                    assert_eq!(selection.effort, effort, "{subset:?}");
                }
                // Where it reported "no agent CLI", the registry now reaches
                // the open runtime if one is installed — the only behavior the
                // unset default gained.
                None if subset.contains(&"opencode") => {
                    assert_eq!(selected(routing).provider.id, "opencode");
                }
                None => assert_eq!(
                    routing,
                    PlannerRouting::Unavailable {
                        message: NO_AGENT_CLI_MESSAGE
                    }
                ),
            }
        }
    }
}

#[test]
fn only_opencode_installed_routes_the_planner_through_opencode() {
    for setting in [auto(), chose("opencode"), chose("claude")] {
        let selection = selected(resolve_with(&setting, codex(), installed(&["opencode"])));
        assert_eq!(selection.provider.id, "opencode");
        assert_eq!(selection.provider.transport, PlannerTransport::OpencodeRun);
        assert_eq!(
            selection.model, None,
            "o8 pins no model for an open runtime — the CLI runs the operator's own"
        );
        assert_eq!(selection.effort, RUNTIME_CONFIGURED_EFFORT);
        assert_eq!(selection.model_label(), "opencode");
    }
}

#[test]
fn a_missing_pick_falls_through_to_open_runtimes_first() {
    // Claude chosen but absent: the fallback prefers the open runtime over the
    // other proprietary CLI.
    let selection = selected(resolve_with(
        &chose("claude"),
        codex(),
        installed(&["codex", "opencode"]),
    ));
    assert_eq!(selection.provider.id, "opencode");
    // …and still lands on whatever IS installed when the open runtime is not.
    let selection = selected(resolve_with(&chose("claude"), codex(), installed(&["codex"])));
    assert_eq!(selection.provider.id, "codex");
    // Nothing installed at all is an explicit dock state, not a silent stall.
    assert_eq!(
        resolve_with(&chose("opencode"), codex(), installed(&[])),
        PlannerRouting::Unavailable {
            message: NO_AGENT_CLI_MESSAGE
        }
    );
}

#[test]
fn the_tier_setting_selects_the_other_rung_of_each_ladder() {
    let builder = BrainSetting {
        tier: Some(PlannerTier::Builder),
        ..chose("claude")
    };
    let selection = selected(resolve_with(&builder, claude(), all_installed));
    assert_eq!(
        selection.model.as_deref(),
        Some(BUILDER_CLAUDE_PLANNER_MODEL)
    );
    assert_eq!(selection.effort, "high");

    let worker = BrainSetting {
        tier: Some(PlannerTier::Worker),
        ..chose("codex")
    };
    let selection = selected(resolve_with(&worker, codex(), all_installed));
    assert_eq!(
        selection.model.as_deref(),
        Some(WORKER_CODEX_PLANNER_MODEL)
    );
    assert_eq!(selection.effort, "medium");
}

#[test]
fn a_model_pin_only_rides_the_adapter_it_is_valid_for() {
    let pinned = BrainSetting {
        model: Some(crate::models::CLAUDE_FABLE_5.to_string()),
        ..chose("claude")
    };
    // Valid for the Claude seat — an explicit pin may still name the frontier id.
    let selection = selected(resolve_with(&pinned, claude(), all_installed));
    assert_eq!(
        selection.model.as_deref(),
        Some(crate::models::CLAUDE_FABLE_5)
    );
    assert_eq!(selection.effort, "high");

    // The same stale pin must NOT ride an opencode spawn — that seat falls back
    // to the model the operator configured for it.
    let stale = BrainSetting {
        provider: Some("opencode".to_string()),
        ..pinned.clone()
    };
    assert_eq!(
        selected(resolve_with(&stale, claude(), all_installed)).model,
        None
    );

    // An opencode-shaped pin does ride it.
    let open_pin = BrainSetting {
        model: Some("openrouter/some-model".to_string()),
        ..chose("opencode")
    };
    assert_eq!(
        selected(resolve_with(&open_pin, claude(), all_installed)).model,
        Some("openrouter/some-model".to_string())
    );
    // …and a garbage pin is dropped rather than handed to the CLI.
    let junk = BrainSetting {
        model: Some("rm -rf /".to_string()),
        ..chose("opencode")
    };
    assert_eq!(selected(resolve_with(&junk, claude(), all_installed)).model, None);
}

#[test]
fn orchestrator_backend_setting_picks_the_planner_provider() {
    for (backend, expected) in [
        ("codex", "codex"),
        ("claude", "claude"),
        ("collide", "claude"),
        ("fable", "claude"),
        ("openclaw", "codex"),
        ("hermes", "codex"),
        ("something-new", "codex"),
    ] {
        assert_eq!(
            preferred_provider_from(Some(&json!({ "orchestratorBackend": backend }))).id,
            expected,
            "backend {backend}"
        );
    }
    assert_eq!(
        preferred_provider_from(Some(
            &json!({ "orchestratorBackend": "auto", "inAppOrchestratorEnabled": true })
        ))
        .id,
        "claude"
    );
    assert_eq!(
        preferred_provider_from(Some(
            &json!({ "orchestratorBackend": "auto", "inAppOrchestratorEnabled": false })
        ))
        .id,
        "codex"
    );
    assert_eq!(preferred_provider_from(Some(&json!({}))).id, "codex");
    assert_eq!(preferred_provider_from(None).id, "codex");
}

#[test]
fn the_brain_setting_reads_off_the_voice_pref_shape() {
    assert_eq!(brain_setting_from(None), BrainSetting::default());
    assert_eq!(
        brain_setting_from(Some(&json!({
            BRAIN_PROVIDER_PREF: "auto",
            BRAIN_TIER_PREF: "  ",
            BRAIN_MODEL_PREF: "",
        }))),
        BrainSetting::default(),
        "auto and empty strings mean unset, not a provider named 'auto'"
    );
    assert_eq!(
        brain_setting_from(Some(&json!({
            BRAIN_PROVIDER_PREF: "opencode",
            BRAIN_TIER_PREF: "builder",
            BRAIN_MODEL_PREF: "openrouter/some-model",
        }))),
        BrainSetting {
            provider: Some("opencode".to_string()),
            tier: Some(PlannerTier::Builder),
            model: Some("openrouter/some-model".to_string()),
        }
    );
}

#[test]
fn brain_state_reports_the_resolved_seat_and_names_a_missing_pick() {
    let state = brain_state_with(&chose("claude"), codex(), installed(&["opencode"]));
    assert_eq!(state.provider, "claude");
    assert_eq!(state.fell_back_from.as_deref(), Some("claude"));
    assert_eq!(state.resolved_provider, Some("opencode"));
    assert_eq!(state.resolved_effort, Some(RUNTIME_CONFIGURED_EFFORT));
    assert_eq!(state.resolved_model, None);
    let installed_ids: Vec<&str> = state
        .adapters
        .iter()
        .filter(|adapter| adapter.installed)
        .map(|adapter| adapter.id)
        .collect();
    assert_eq!(installed_ids, vec!["opencode"]);

    let state = brain_state_with(&auto(), codex(), all_installed);
    assert_eq!(state.provider, "auto");
    assert_eq!(state.tier, "auto");
    assert_eq!(state.fell_back_from, None);
    assert_eq!(state.resolved_provider, Some("codex"));
    assert_eq!(
        state.resolved_model.as_deref(),
        Some(DEFAULT_CODEX_PLANNER_MODEL)
    );

    let state = brain_state_with(&auto(), codex(), installed(&[]));
    assert_eq!(state.resolved_provider, None);
    assert_eq!(state.detail, Some(NO_AGENT_CLI_MESSAGE));
}

#[test]
fn bound_selection_accepts_catalog_models_and_rejects_raw_cli_values() {
    assert_eq!(
        resolve_bound_with("codex", crate::models::CODEX_GPT_6_SOL, "medium", all_installed),
        PlannerRouting::Selected(PlannerSelection {
            provider: codex(),
            binary: "/mock/codex".to_string(),
            model: Some(crate::models::CODEX_GPT_6_SOL.to_string()),
            effort: "medium",
        })
    );
    assert_eq!(
        resolve_bound_with("codex", crate::models::CODEX_GPT_6_LUNA, "medium", all_installed),
        PlannerRouting::Selected(PlannerSelection {
            provider: codex(),
            binary: "/mock/codex".to_string(),
            model: Some(crate::models::CODEX_GPT_6_LUNA.to_string()),
            effort: "medium",
        })
    );
    assert_eq!(
        resolve_bound_with("codex", crate::models::CODEX_GPT_5_6_SOL, "xhigh", all_installed),
        PlannerRouting::Selected(PlannerSelection {
            provider: codex(),
            binary: "/mock/codex".to_string(),
            model: Some(crate::models::CODEX_GPT_5_6_SOL.to_string()),
            effort: "xhigh",
        })
    );
    // An explicit pin may still seat the frontier model.
    assert_eq!(
        resolve_bound_with("claude", crate::models::CLAUDE_FABLE_5, "high", all_installed),
        PlannerRouting::Selected(PlannerSelection {
            provider: claude(),
            binary: "/mock/claude".to_string(),
            model: Some(crate::models::CLAUDE_FABLE_5.to_string()),
            effort: "high",
        })
    );
    // The open seat round-trips its own reported effort.
    assert_eq!(
        resolve_bound_with(
            "opencode",
            "openrouter/some-model",
            RUNTIME_CONFIGURED_EFFORT,
            all_installed
        ),
        PlannerRouting::Selected(PlannerSelection {
            provider: adapter_by_id("opencode").unwrap(),
            binary: "/mock/opencode".to_string(),
            model: Some("openrouter/some-model".to_string()),
            effort: RUNTIME_CONFIGURED_EFFORT,
        })
    );
    assert_eq!(
        resolve_bound_with("codex", "gpt-unknown", "xhigh", all_installed),
        PlannerRouting::Unavailable {
            message: INVALID_PLANNER_SELECTION_MESSAGE,
        }
    );
    assert_eq!(
        resolve_bound_with("claude", crate::models::CLAUDE_OPUS_5, "ultra", all_installed),
        PlannerRouting::Unavailable {
            message: INVALID_PLANNER_SELECTION_MESSAGE,
        }
    );
    // A catalog seat never accepts the open seat's effort name.
    assert_eq!(
        resolve_bound_with(
            "claude",
            crate::models::CLAUDE_OPUS_5,
            RUNTIME_CONFIGURED_EFFORT,
            all_installed
        ),
        PlannerRouting::Unavailable {
            message: INVALID_PLANNER_SELECTION_MESSAGE,
        }
    );
    assert_eq!(
        resolve_bound_with("nope", crate::models::CLAUDE_OPUS_5, "high", all_installed),
        PlannerRouting::Unavailable {
            message: INVALID_PLANNER_SELECTION_MESSAGE,
        }
    );
}

#[test]
fn unavailable_models_advance_the_high_effort_fallback_chain() {
    assert_eq!(
        claude_fallback_selection("/mock/claude", crate::models::CLAUDE_FABLE_5),
        Some(PlannerSelection {
            provider: claude(),
            binary: "/mock/claude".to_string(),
            model: Some(crate::models::CLAUDE_OPUS_5.to_string()),
            effort: "high",
        })
    );
    assert_eq!(
        claude_fallback_selection("/mock/claude", crate::models::CLAUDE_OPUS_5),
        Some(PlannerSelection {
            provider: claude(),
            binary: "/mock/claude".to_string(),
            model: Some(crate::models::CLAUDE_OPUS_4_8.to_string()),
            effort: "high",
        })
    );
    assert_eq!(
        claude_fallback_selection("/mock/claude", crate::models::CLAUDE_OPUS_4_8),
        None
    );

    assert_eq!(
        effective_claude_model_with_availability(crate::models::CLAUDE_FABLE_5, false, false),
        crate::models::CLAUDE_FABLE_5
    );
    assert_eq!(
        effective_claude_model_with_availability(crate::models::CLAUDE_FABLE_5, true, false),
        crate::models::CLAUDE_OPUS_5
    );
    assert_eq!(
        effective_claude_model_with_availability(crate::models::CLAUDE_FABLE_5, true, true),
        crate::models::CLAUDE_OPUS_4_8
    );
    assert_eq!(
        effective_claude_model_with_availability(crate::models::CLAUDE_OPUS_5, false, true),
        crate::models::CLAUDE_OPUS_4_8
    );
    // The worker default is the base rung — it has no lower fallback and is
    // never rewritten by the degrade chain.
    assert_eq!(
        effective_claude_model_with_availability(DEFAULT_CLAUDE_PLANNER_MODEL, true, true),
        crate::models::CLAUDE_SONNET_5
    );
}

#[test]
fn every_registry_entry_is_addressable_and_distinct() {
    for adapter in PLANNER_ADAPTERS {
        assert_eq!(adapter_by_id(adapter.id).map(|found| found.id), Some(adapter.id));
        assert!(!adapter.binary_env.is_empty(), "{} needs an env override", adapter.id);
        assert_eq!(
            adapter.worker_model.is_none(),
            adapter.builder_model.is_none(),
            "{} must define both rungs or neither",
            adapter.id
        );
    }
    assert_eq!(PLANNER_ADAPTERS.len(), OPEN_PREFERENCE.len());
    for id in OPEN_PREFERENCE {
        assert!(adapter_by_id(id).is_some(), "{id} is not a registry entry");
    }
}

#[test]
fn the_voice_pref_keys_are_the_ones_the_settings_panel_writes() {
    // Spelled out so a rename here shows up as a failing contract rather than a
    // setting that silently stops applying. `voice_prefs_set` and the seat
    // fixtures write these exact keys.
    assert_eq!(BRAIN_PROVIDER_PREF, "symon_brain_provider");
    assert_eq!(BRAIN_TIER_PREF, "symon_brain_tier");
    assert_eq!(BRAIN_MODEL_PREF, "symon_brain_model");
}

#[test]
fn new_text_default_is_61_high_while_pins_bound_sessions_and_voice_stay_fixed() {
    let (routing, retry) = resolve_text_with(&auto(), codex(), all_installed);
    let seat = selected(routing);
    assert_eq!(seat.model_label(), crate::models::CODEX_GPT_6_1_SOL);
    assert_eq!(seat.effort, "high");
    assert!(retry);
    assert_eq!(selected(resolve_with(&auto(), codex(), all_installed)).model_label(), crate::models::CODEX_GPT_5_6_SOL);
    for model in [crate::models::CODEX_GPT_5_6_SOL, crate::models::CODEX_GPT_6_SOL, crate::models::CODEX_GPT_6_1_SOL] {
        let (routing, retry) = resolve_text_with(&BrainSetting { model: Some(model.into()), ..auto() }, codex(), all_installed);
        assert_eq!(selected(routing).model_label(), model);
        assert!(!retry);
        assert_eq!(selected(resolve_bound_with("codex", model, "high", all_installed)).model_label(), model);
    }
}
