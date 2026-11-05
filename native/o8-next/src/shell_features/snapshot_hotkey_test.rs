// Real shell, Settings and composer paths; only the macOS edges are faked.
use super::snapshot_hotkey::{Hotkey, Os};
use super::*;
use crate::shell::test_support::*;
use crate::snapshot_hotkey::{self as hotkey, Mode, Monitor, Shift};
use std::cell::{Cell, RefCell};
struct SnapshotHotkeyTests;
register_shell_feature!(SnapshotHotkeyTests);
impl ShellFeature for SnapshotHotkeyTests {}

thread_local! {
    static GRANTED: Cell<bool> = const { Cell::new(true) };
    static PROMPTS: Cell<u32> = const { Cell::new(0) };
    static LIVE: Cell<i32> = const { Cell::new(0) };
    static SENDER: RefCell<Option<async_channel::Sender<Shift>>> = const { RefCell::new(None) };
}
struct Registered;
impl Drop for Registered {
    fn drop(&mut self) {
        LIVE.with(|live| live.set(live.get() - 1));
        SENDER.with(|sender| sender.borrow_mut().take());
    }
}
fn fake_os() -> Os {
    Os {
        permitted: |prompt| {
            let granted = GRANTED.with(Cell::get);
            if prompt && !granted {
                PROMPTS.with(|prompts| prompts.set(prompts.get() + 1));
            }
            granted
        },
        register: |sender| {
            LIVE.with(|live| live.set(live.get() + 1));
            SENDER.with(|slot| *slot.borrow_mut() = Some(sender));
            Some(Box::new(Registered) as Monitor)
        },
        capture: |_, path| std::fs::write(path, png()).map_err(|error| error.to_string()),
        path: || Some(scratch_path("o8-snapshot").with_extension("png")),
    }
}
fn png() -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAIAAAAJh2qgAAAAVklEQVR4nO3PAQ3AIADAMEAOnlCOmbv4k71VsM197viT9XXA2wzXGa4zXGe4znCd4TrDdYbrDNcZrjNcZ7jOcJ3hOsN1husM1xmuM1xnuM5wneE6w3UPI0QBwum7oOkAAAAASUVORK5CYII=").unwrap()
}
fn registered(s: &Entity<Shell>, v: &VisualTestContext) -> bool {
    s.read_with(v, |s, _| {
        s.features.read::<Hotkey>().is_some_and(Hotkey::registered)
    })
}
fn press(click: &str, v: &mut VisualTestContext) {
    draw(v);
    let bounds = v
        .debug_bounds(Box::leak(click.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {click}"));
    v.simulate_click(bounds.center(), gpui::Modifiers::default());
    v.run_until_parked();
    draw(v);
}
fn shift(right: bool, down: bool, ms: u64) {
    let sender = SENDER
        .with(|slot| slot.borrow().clone())
        .expect("registered monitor");
    sender
        .try_send(Shift {
            right,
            down,
            at: Duration::from_millis(ms),
        })
        .unwrap();
}
fn active_chat(s: &Entity<Shell>, v: &VisualTestContext) -> Option<Entity<crate::ui::Surface>> {
    s.read_with(v, |s, _| {
        match s.active().and_then(|tab| s.content.get(&s.key(&tab))) {
            Some(Content::Session(view)) => Some(view.clone()),
            _ => None,
        }
    })
}

#[gpui::test]
fn snapshot_hotkey_setting_gates_registration(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("snapshot-settings.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    s.update(&mut v, |s, _| s.features.get::<Hotkey>().os = fake_os());
    assert!(!registered(&s, &v), "off by default: no monitor");

    v.simulate_keystrokes("cmd-,");
    press("settings-nav-keyboard", &mut v);
    assert!(
        v.debug_bounds("setting-snapshot-hotkey-permission")
            .is_some()
    );
    press("setting-snapshot-hotkey-screen", &mut v);
    assert_eq!(hotkey::mode(), Mode::Screen);
    assert!(registered(&s, &v), "turning it on registers the monitor");
    assert_eq!(LIVE.with(Cell::get), 1);
    press("setting-snapshot-hotkey-window", &mut v);
    assert_eq!(
        LIVE.with(Cell::get),
        1,
        "changing the target keeps one monitor"
    );
    press("setting-snapshot-hotkey-off", &mut v);
    assert_eq!(hotkey::mode(), Mode::Off);
    assert!(!registered(&s, &v), "turning it off unregisters");
    assert_eq!(LIVE.with(Cell::get), 0);

    // Missing permission: the system prompt and its path, and nothing else.
    GRANTED.with(|granted| granted.set(false));
    press("setting-snapshot-hotkey-screen", &mut v);
    assert!(!registered(&s, &v));
    assert_eq!(LIVE.with(Cell::get), 0);
    assert_eq!(
        PROMPTS.with(Cell::get),
        1,
        "macOS shows its permission prompt"
    );
    let toasts = v.update(|_, cx| toasts_api::texts(cx));
    assert!(
        toasts
            .iter()
            .any(|text| text.contains(hotkey::PERMISSION_PATH)),
        "{toasts:?}"
    );
    hotkey::set_mode(Mode::Off);
}

#[gpui::test]
fn snapshot_hotkey_capture_is_the_first_attachment_of_a_new_chat(cx: &mut TestAppContext) {
    let f = Fixture::start(true);
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("snapshot-capture.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    let before = active_chat(&s, &v).and_then(|chat| chat.read_with(&v, |c, _| c.shown_thread()));
    s.update_in(&mut v, |s, w, cx| {
        s.features.get::<Hotkey>().os = fake_os();
        hotkey::set_mode(Mode::Screen);
        s.apply_snapshot_hotkey(false, w, cx);
    });
    assert!(registered(&s, &v));

    // One Shift alone and a slow second Shift capture nothing.
    shift(false, true, 1_000);
    shift(false, false, 1_050);
    shift(false, true, 2_000);
    shift(true, true, 2_400);
    shift(true, false, 2_500);
    shift(false, false, 2_500);
    v.run_until_parked();
    assert!(
        s.read_with(&v, |s, _| s.features.read::<Hotkey>().unwrap().idle()),
        "no capture without the chord"
    );

    shift(false, true, 3_000);
    shift(true, true, 3_090);
    let mut images = vec![];
    for _ in 0..40 {
        s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
        v.run_until_parked();
        draw(&mut v);
        images = active_chat(&s, &v)
            .map(|chat| chat.read_with(&v, |c, cx| c.shell_composer_images(cx)))
            .unwrap_or_default();
        if !images.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let diagnostics = (
        v.update(|_, cx| toasts_api::texts(cx)),
        s.read_with(&v, |s, _| s.features.read::<Hotkey>().unwrap().idle()),
        s.read_with(&v, |s, _| (s.state.selected.clone(), s.active())),
    );
    let chat = active_chat(&s, &v).expect("a chat is open");
    let shown = chat.read_with(&v, |c, _| c.shown_thread()).unwrap();
    assert!(
        shown.starts_with("thoughts-next-"),
        "{shown} {diagnostics:?}"
    );
    assert_ne!(Some(shown), before, "the capture opens a new chat");
    assert_eq!(images.len(), 1, "{images:?}");
    let name = images[0]["name"].as_str().unwrap();
    assert!(
        name.starts_with("o8-snapshot-") && name.ends_with(".png"),
        "{name}"
    );
    assert!(
        images[0]["dataUri"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"),
        "the composer's image path carries the capture to the server"
    );
    assert!(
        chat.update_in(&mut v, |c, w, cx| c.shell_selection(w, cx).1),
        "the composer is focused, ready to type"
    );
    hotkey::set_mode(Mode::Off);
}
