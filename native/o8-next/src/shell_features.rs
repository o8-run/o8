//! Small, ordered shell registries. Contributions and their state live in modules.
use super::*;
use crate::theme::current as theme;
use gpui::AnyElement;
use registry::{Frame, KeyResult};
use std::{
    any::{Any, TypeId},
    sync::LazyLock,
};

type Hook = fn(&mut Shell, &mut Window, &mut Context<Shell>);
pub(super) struct TickHook {
    pub order: i32,
    pub run: fn(&mut Shell, bool, &mut Window, &mut Context<Shell>),
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RenderGroup {
    Chrome,
    Content,
}
pub(super) struct RenderSlot {
    pub group: RenderGroup,
    pub order: i32,
    pub render: fn(&mut Shell, &Frame, &mut Window, &mut Context<Shell>) -> Option<AnyElement>,
}
pub(super) struct KeyContext {
    pub bind_root: Option<fn(gpui::Div, &Shell, &mut Context<Shell>) -> gpui::Div>,
    pub order: i32,
    pub dispatch: fn(&mut Shell, &KeyDownEvent, &mut Window, &mut Context<Shell>) -> KeyResult,
}
pub(super) struct PaletteCommands {
    pub order: i32,
    pub collect: fn(&Shell) -> Vec<Command>,
}
pub(super) struct PreferenceObserver {
    pub order: i32,
    pub install: Hook,
}

/// New commands carry their own handler; the shell never grows another match arm.
pub(super) struct PaletteCommand {
    pub id: &'static str,
    pub label: &'static str,
    pub run: Hook,
}

pub(super) trait ShellFeature: Sync {
    // Feature-owned connection policy uses the same lifecycle dispatch as surfaces.
    fn extension(&self) -> Option<&'static dyn registry::ShellExtension> {
        None
    }
    fn ticks(&self) -> &'static [TickHook] {
        &[]
    }
    fn slots(&self) -> &'static [RenderSlot] {
        &[]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[]
    }
    fn commands(&self) -> &'static [PaletteCommands] {
        &[]
    }
    fn execute(
        &self,
        _s: &mut Shell,
        _command: &Command,
        _w: &mut Window,
        _cx: &mut Context<Shell>,
    ) -> bool {
        false
    }
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[]
    }
}
macro_rules! register_shell_feature {
    ($feature:expr) => {
        pub(super) const FEATURE: &dyn ShellFeature = &$feature;
    };
}
include!(concat!(env!("OUT_DIR"), "/shell_features.rs"));

// GPUI entities and subscriptions stay window-local, never in the static registry.
#[derive(Default)]
pub(super) struct State(HashMap<TypeId, Box<dyn Any>>);
impl State {
    pub fn read<T: Default + 'static>(&self) -> Option<&T> {
        self.0
            .get(&TypeId::of::<T>())
            .and_then(|state| state.downcast_ref())
    }
    pub fn get<T: Default + 'static>(&mut self) -> &mut T {
        self.0
            .entry(TypeId::of::<T>())
            .or_insert_with(|| Box::<T>::default())
            .downcast_mut()
            .expect("feature state type")
    }
}
pub(super) fn extensions() -> impl Iterator<Item = &'static dyn registry::ShellExtension> {
    modules()
        .iter()
        .filter_map(|(_, feature)| feature.extension())
}
fn ordered<T: 'static>(
    select: impl Fn(&dyn ShellFeature) -> &'static [T],
    order: impl Fn(&T) -> i32,
) -> Vec<&'static T> {
    let mut entries = modules()
        .iter()
        .flat_map(|(name, feature)| {
            select(*feature)
                .iter()
                .enumerate()
                .map(move |(index, entry)| (*name, index, entry))
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|(name, index, entry)| (order(entry), *name, *index));
    entries.into_iter().map(|(_, _, entry)| entry).collect()
}
static TICKS: LazyLock<Vec<&'static TickHook>> =
    LazyLock::new(|| ordered(|f| f.ticks(), |h| h.order));
static SLOTS: LazyLock<Vec<&'static RenderSlot>> =
    LazyLock::new(|| ordered(|f| f.slots(), |h| h.order));
static KEYS: LazyLock<Vec<&'static KeyContext>> =
    LazyLock::new(|| ordered(|f| f.keys(), |h| h.order));
static COMMANDS: LazyLock<Vec<&'static PaletteCommands>> =
    LazyLock::new(|| ordered(|f| f.commands(), |h| h.order));
static OBSERVERS: LazyLock<Vec<&'static PreferenceObserver>> =
    LazyLock::new(|| ordered(|f| f.observers(), |h| h.order));
pub(super) fn observe(s: &mut Shell, w: &mut Window, cx: &mut Context<Shell>) {
    for observer in OBSERVERS.iter() {
        (observer.install)(s, w, cx);
    }
}
pub(super) fn tick(s: &mut Shell, refresh: bool, w: &mut Window, cx: &mut Context<Shell>) {
    for hook in TICKS.iter() {
        (hook.run)(s, refresh, w, cx);
    }
}
pub(super) fn render_chrome(
    s: &mut Shell,
    frame: &Frame,
    w: &mut Window,
    cx: &mut Context<Shell>,
) -> Vec<AnyElement> {
    SLOTS
        .iter()
        .filter(|slot| slot.group == RenderGroup::Chrome)
        .filter_map(|slot| (slot.render)(s, frame, w, cx))
        .collect()
}
// Place the retained chrome group once, at its first slot. Content slots keep
// their order around it, including the material veil and first-paint receipt.
pub(super) fn render_content(
    s: &mut Shell,
    frame: &Frame,
    chrome: AnyElement,
    w: &mut Window,
    cx: &mut Context<Shell>,
) -> Vec<AnyElement> {
    let mut chrome = Some(chrome);
    SLOTS
        .iter()
        .filter_map(|slot| match slot.group {
            RenderGroup::Chrome => chrome.take(),
            RenderGroup::Content => (slot.render)(s, frame, w, cx),
        })
        .collect()
}
pub(super) fn bind_input(root: gpui::Div, s: &Shell, cx: &mut Context<Shell>) -> gpui::Div {
    KEYS.iter()
        .filter_map(|context| context.bind_root)
        .fold(root, |root, bind| bind(root, s, cx))
}
pub(super) fn key(
    s: &mut Shell,
    e: &KeyDownEvent,
    w: &mut Window,
    cx: &mut Context<Shell>,
) -> KeyResult {
    for context in KEYS.iter() {
        let result = (context.dispatch)(s, e, w, cx);
        if result != KeyResult::Unhandled {
            return result;
        }
    }
    KeyResult::Unhandled
}
pub(super) fn commands(s: &Shell) -> Vec<Command> {
    COMMANDS
        .iter()
        .flat_map(|source| (source.collect)(s))
        .collect()
}

pub(super) fn execute(
    s: &mut Shell,
    command: &Command,
    w: &mut Window,
    cx: &mut Context<Shell>,
) -> bool {
    if let Command::Feature(command) = command {
        (command.run)(s, w, cx);
        return true;
    }
    modules()
        .iter()
        .any(|(_, feature)| feature.execute(s, command, w, cx))
}
