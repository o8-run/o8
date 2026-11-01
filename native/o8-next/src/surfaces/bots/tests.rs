use super::requests::{BotEntry, BotIcon, BotThreadRef, encode};
use super::*;
use crate::shell::test_support::*;
use gpui::TestAppContext;

fn grok() -> BotEntry {
    BotEntry {
        id: "grok:agent-1".into(),
        house: "grok".into(),
        name: "cash".into(),
        icon: BotIcon {
            key: Some("grok".into()),
            url: None,
        },
        main_thread: Some(BotThreadRef {
            kind: "mailbox".into(),
            id: Some("agent-1".into()),
            url: Some("grokbot://app/v1/agent?id=agent-1".into()),
        }),
        status: "unknown".into(),
    }
}

#[test]
fn api_entries_deserialize_with_optional_fields() {
    let bot: BotEntry = serde_json::from_value(serde_json::json!({
        "id": "grok:agent-1", "house": "grok", "name": "cash",
        "icon": {"key": "grok"},
        "mainThread": {"kind": "mailbox", "id": "agent-1", "url": "grokbot://app/v1/agent?id=agent-1"},
        "status": "unknown"
    }))
    .unwrap();
    assert_eq!(bot, grok());
    let bare: BotEntry =
        serde_json::from_value(serde_json::json!({"id": "c", "house": "codex", "name": "C"}))
            .unwrap();
    assert_eq!(bare.main_thread, None);
}

#[test]
fn ids_are_path_encoded_and_unknown_houses_fall_back_to_the_bot_glyph() {
    assert_eq!(encode("grok:agent-1"), "grok%3Aagent-1");
    assert_ne!(glyph_path("grok", None), glyph_path("codex", None));
    assert_eq!(glyph_path("codex", None), glyph_path("future-house", None));
    assert_eq!(glyph_path("other", Some("grok")), glyph_path("grok", None));
    assert_eq!(view::speaker("bot", "cash"), "cash");
    assert_eq!(view::speaker("user", "cash"), "You");
}

#[gpui::test]
fn bot_entries_sit_under_prs_and_open_their_thread(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--bots");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("bots.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    for _ in 0..4 {
        cx.run_until_parked();
        draw(cx);
    }
    draw(cx);
    let prs = cx
        .debug_bounds("rail-pull-requests")
        .expect("PRs rail entry");
    let bot = cx
        .debug_bounds("rail-bot-grok:agent-1")
        .expect("bot rail entry");
    assert!(bot.top() >= prs.bottom(), "bot entries render below PRs");
    assert!(
        bot.top() - prs.bottom() < gpui::px(4.),
        "and directly under it"
    );
    cx.simulate_click(bot.center(), gpui::Modifiers::none());
    cx.run_until_parked();
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Bot("grok:agent-1".into())),
        "a click opens the bot's main thread in the main pane"
    );
    draw(cx);
}
