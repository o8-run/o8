use super::*;
use crate::shell::test_support::*;

fn open_bot(
    cx: &mut TestAppContext,
) -> (Fixture, Entity<Shell>, VisualTestContext, Entity<BotThread>) {
    let fixture = Fixture::start_mode(false, "--bots");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("bots-view.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |shell, window, cx| {
        shell.execute(Command::Bot("grok:agent-1".into()), window, cx);
    });
    ready(&shell, &mut visual);
    let view = shell.read_with(&mut visual, |shell, _| {
        let tab = shell.active().expect("bot tab");
        let Some(Content::Bot(view)) = shell.content.get(&shell.key(&tab)) else {
            panic!("native bot conversation");
        };
        view.clone()
    });
    assert!(view.read_with(&mut visual, |v, _| v.error.is_none()));
    assert_eq!(view.read_with(&mut visual, |v, _| v.messages.len()), 500);
    (fixture, shell, visual, view)
}

fn requests(fixture: &Fixture) -> u64 {
    fixture
        .client
        .get::<Value>("/__fixture/bots/requests", &[])
        .unwrap()["requests"]
        .as_u64()
        .unwrap()
}

fn replace(fixture: &Fixture, start: usize, count: usize, tall: bool) {
    let messages = (start..start + count).map(|n| json!({
        "id": format!("message-{n}"), "role": "bot",
        "text": if tall && n == start + count - 1 { "a taller incoming message\n".repeat(30) } else { format!("Message {n}") },
        "at": format!("2026-10-31T12:{:02}:{:02}Z", n / 60, n % 60),
    })).collect::<Vec<_>>();
    let url = fixture.client.url("/__fixture/bots").unwrap();
    let response = fixture
        .client
        .request("POST", &url)
        .send_json(json!({ "messages": messages }))
        .unwrap();
    assert_eq!(response.status(), 200);
}

fn refresh(shell: &Entity<Shell>, view: &Entity<BotThread>, cx: &mut VisualTestContext) {
    shell.update_in(cx, |shell, window, cx| {
        shell.execute(Command::Refresh, window, cx)
    });
    for _ in 0..20 {
        cx.run_until_parked();
        draw(cx);
        if view.read_with(cx, |v, _| !v.in_flight) {
            return;
        }
    }
    panic!("bot transcript refresh completed");
}

#[gpui::test]
fn maintenance_honors_bot_poll_interval_and_explicit_refresh_still_works(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, view) = open_bot(cx);
    let cx = &mut visual;
    let before = requests(&fixture);
    view.update(cx, |view, _| view.fetched = Some(Instant::now()));
    shell.update_in(cx, |shell, window, cx| shell.tick(true, window, cx));
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        requests(&fixture),
        before,
        "one-second maintenance must honor the ten-second bot interval"
    );
    refresh(&shell, &view, cx);
    assert_eq!(
        requests(&fixture),
        before + 1,
        "explicit Refresh must bypass the interval"
    );
    view.update(cx, |view, _| view.fetched = Some(Instant::now() - REFRESH));
    shell.update_in(cx, |shell, window, cx| shell.tick(true, window, cx));
    cx.run_until_parked();
    assert_eq!(
        requests(&fixture),
        before + 2,
        "due maintenance refreshes the bot"
    );
}

#[gpui::test]
fn a_new_message_at_the_500_message_cap_follows_when_already_at_the_bottom(
    cx: &mut TestAppContext,
) {
    let (fixture, shell, mut visual, view) = open_bot(cx);
    let cx = &mut visual;
    view.update(cx, |view, _| view.scroll.scroll_to_bottom());
    draw(cx);
    replace(&fixture, 1, 500, true);
    refresh(&shell, &view, cx);
    assert_eq!(
        view.read_with(cx, |view, _| view.messages.last().unwrap().id.clone()),
        "message-500"
    );
    let (offset, maximum) = view.read_with(cx, |view, _| {
        (view.scroll.offset().y, view.scroll.max_offset().height)
    });
    assert!(maximum > px(0.), "transcript overflows its viewport");
    assert!(
        (maximum + offset).abs() < px(2.),
        "capped window follows the latest turn: {offset:?} / {maximum:?}"
    );
}

#[gpui::test]
fn incoming_messages_do_not_jump_an_operator_reading_earlier_messages_to_the_bottom(
    cx: &mut TestAppContext,
) {
    let (fixture, shell, mut visual, view) = open_bot(cx);
    let cx = &mut visual;
    replace(&fixture, 0, 30, false);
    refresh(&shell, &view, cx);
    view.update(cx, |view, _| {
        view.scroll.set_offset(gpui::point(px(0.), px(-100.)))
    });
    draw(cx);
    let before = view.read_with(cx, |view, _| view.scroll.offset());
    replace(&fixture, 0, 31, true);
    refresh(&shell, &view, cx);
    let after = view.read_with(cx, |view, _| view.scroll.offset());
    assert_eq!(
        after, before,
        "reading position survives an incoming message"
    );
}

fn reading_position(
    view: &Entity<BotThread>,
    cx: &mut VisualTestContext,
) -> (String, gpui::Pixels) {
    view.read_with(cx, |view, _| {
        let index = view.scroll.top_item();
        let bounds = view
            .scroll
            .bounds_for_item(index)
            .expect("visible row bounds");
        (
            view.messages[index].id.clone(),
            bounds.top() + view.scroll.offset().y - view.scroll.bounds().top(),
        )
    })
}

#[gpui::test]
fn capped_window_rollover_preserves_the_message_and_pixel_position_being_read(
    cx: &mut TestAppContext,
) {
    let (fixture, shell, mut visual, view) = open_bot(cx);
    let cx = &mut visual;
    view.update(cx, |view, _| {
        view.scroll.set_offset(gpui::point(px(0.), px(-1000.)))
    });
    draw(cx);
    let before = reading_position(&view, cx);
    replace(&fixture, 1, 500, true);
    refresh(&shell, &view, cx);
    let after = reading_position(&view, cx);
    assert_eq!(after.0, before.0, "rollover preserves the visible message");
    assert!(
        (after.1 - before.1).abs() < px(1.),
        "rollover preserves its within-row position"
    );
}

#[gpui::test]
fn a_hidden_bot_retains_its_reader_anchor_through_an_error_and_recovered_rollover(
    cx: &mut TestAppContext,
) {
    let (fixture, shell, mut visual, view) = open_bot(cx);
    let cx = &mut visual;
    view.update(cx, |view, _| {
        view.scroll.set_offset(gpui::point(px(0.), px(-1000.)))
    });
    draw(cx);
    let before = reading_position(&view, cx);
    shell.update_in(cx, |shell, window, cx| {
        shell.execute(Command::PullRequests, window, cx)
    });
    draw(cx);
    let url = fixture.client.url("/__fixture/bots").unwrap();
    fixture
        .client
        .request("POST", &url)
        .send_json(json!({ "failing": true }))
        .unwrap();
    view.update(cx, |view, _| view.fetched = Some(Instant::now() - REFRESH));
    shell.update_in(cx, |shell, window, cx| shell.tick(true, window, cx));
    cx.run_until_parked();
    draw(cx);
    assert!(view.read_with(cx, |view, _| view.error.is_some()));
    replace(&fixture, 1, 500, true);
    fixture
        .client
        .request("POST", &url)
        .send_json(json!({ "failing": false }))
        .unwrap();
    view.update(cx, |view, _| view.fetched = Some(Instant::now() - REFRESH));
    shell.update_in(cx, |shell, window, cx| shell.tick(true, window, cx));
    cx.run_until_parked();
    draw(cx);
    assert!(view.read_with(cx, |view, _| view.error.is_none()));
    shell.update_in(cx, |shell, window, cx| {
        shell.execute(Command::Bot("grok:agent-1".into()), window, cx)
    });
    draw(cx);
    let after = reading_position(&view, cx);
    assert_eq!(after.0, before.0);
    assert!(
        (after.1 - before.1).abs() < px(1.),
        "hidden recovery preserves the reading position"
    );
}
