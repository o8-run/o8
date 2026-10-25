//! Typed registration glue. Surface policy belongs to the registered modules.
use super::*;
use gpui::AnyElement;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct EmptyState {}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum NavPosition {
    BeforeWorkspaces,
    AfterWorkspaces,
}

pub(super) struct WorkspaceLoad {
    pub paths: BTreeSet<String>,
    pub active_project: Option<Vec<String>>,
}

type OpenSurface = fn(&mut Shell, Command, &mut Window, &mut Context<Shell>) -> Option<(Tab, bool)>;

/// Optional lifecycle and chrome extension; existing registrations retain defaults.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum KeyResult {
    Unhandled,
    Handled,
    Propagate,
}
pub(super) struct Frame {
    pub brand: Option<&'static str>,
    pub commands: &'static str,
    pub status: bool,
    pub retry: bool,
    pub empty: &'static str,
}
impl Default for Frame {
    fn default() -> Self {
        Self {
            brand: Some("o8 next alpha"),
            commands: "Commands (Ctrl+K / Cmd+K)",
            status: true,
            retry: true,
            empty: "Open a saved session or grid from Commands.",
        }
    }
}
pub(super) trait ShellExtension: Sync {
    fn load(&self, _s: &mut Shell, _cx: &mut Context<Shell>) -> bool {
        false
    }
    fn prepare(&self, _s: &mut Shell, _w: &mut Window, _cx: &mut Context<Shell>) {}
    fn tick(&self, _s: &mut Shell, _refresh: bool, _w: &mut Window, _cx: &mut Context<Shell>) {}
    fn key(
        &self,
        _s: &mut Shell,
        _e: &KeyDownEvent,
        _w: &mut Window,
        _cx: &mut Context<Shell>,
    ) -> KeyResult {
        KeyResult::Unhandled
    }
    fn frame(&self, _s: &Shell) -> Option<Frame> {
        None
    }
    fn palette(&self, _s: &Shell, _cx: &mut Context<Shell>) -> Option<AnyElement> {
        None
    }
    fn allow_command(&self, _s: &Shell, _c: &Command) -> bool {
        true
    }
    fn allow_switch(&self, _s: &Shell) -> bool {
        true
    }
}
pub(super) fn extensions() -> impl Iterator<Item = &'static dyn ShellExtension> {
    registrations().iter().filter_map(|r| r.extension)
}
pub(super) struct Registration {
    pub extension: Option<&'static dyn ShellExtension>,
    pub tab_label: &'static str,
    pub command_label: &'static str,
    pub command: Option<(usize, fn() -> Command)>,
    pub open: OpenSurface,
    pub create: fn(&mut Shell, Tab, String, &mut Window, &mut Context<Shell>) -> Option<Content>,
    pub global: bool,
    pub overlay_command: bool,
    pub overlay: fn(&Shell) -> Option<AnyElement>,
    pub overlay_open: fn(&Shell) -> bool,
    pub block_ensure: fn(&Shell) -> bool,
    pub focus_overlay: fn(&Shell, &mut Window, &mut Context<Shell>) -> bool,
    pub nav: fn(&Shell, NavPosition, &mut Context<Shell>) -> Vec<AnyElement>,
    pub key_down: fn(&mut Shell, &KeyDownEvent, &mut Window, &mut Context<Shell>) -> bool,
    pub capture: fn(&mut Shell, &Window, &App),
    pub remove: fn(&mut Workspace, &Tab),
    pub before_tab: fn(&mut Shell),
    pub after_tab: fn(&mut Shell),
    pub workspaces: fn(&Client, &mut WorkspaceLoad),
    pub frame_probe: fn(&Shell) -> Option<AnyElement>,
    pub tick: fn(&mut Shell, &mut Context<Shell>),
}
impl Registration {
    pub const fn new(
        tab_label: &'static str,
        command_label: &'static str,
        open: OpenSurface,
    ) -> Self {
        Self {
            extension: None,
            tab_label,
            command_label,
            open,
            command: None,
            create: |_, _, _, _, _| None,
            global: false,
            overlay_command: false,
            overlay: |_| None,
            overlay_open: |_| false,
            block_ensure: |_| false,
            focus_overlay: |_, _, _| false,
            nav: |_, _, _| vec![],
            key_down: |_, _, _, _| false,
            capture: |_, _, _| {},
            remove: |_, _| {},
            before_tab: |_| {},
            after_tab: |_| {},
            workspaces: |_, _| {},
            frame_probe: |_| None,
            tick: |_, _| {},
        }
    }
}

pub(super) trait ShellView: Render {
    fn focus(view: &Entity<Self>, composer: bool, window: &mut Window, cx: &mut Context<Shell>);
    fn tick(_view: &Entity<Self>, _refresh: bool, _cx: &mut Context<Shell>) {}
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool;
}

macro_rules! register_surfaces {
    (
        tabs { $( $(#[$tab_attr:meta])* $module:ident : $variant:ident $(($payload:ty))? = $path:literal; )* }
        commands { $( $(#[$command_attr:meta])* $command_module:ident : $command_variant:ident = $command_path:literal; )* }
    ) => {
        $( $(#[$tab_attr])* #[path = $path] pub(crate) mod $module; )*
        $( $(#[$command_attr])* #[path = $command_path] pub(crate) mod $command_module; )*

        #[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
        #[serde(tag = "surface", content = "session")]
        pub enum Tab { $( $(#[$tab_attr])* $variant $(($payload))?, )* }
        impl Tab {
            fn registration(&self) -> &'static Registration {
                match self { $( $(#[$tab_attr])* Self::$variant { .. } => &$module::REGISTRATION, )* }
            }
            pub fn label(&self) -> &'static str { self.registration().tab_label }
        }
        #[derive(Clone)]
        enum Command {
            $( $(#[$tab_attr])* $variant $(($payload))?, )*
            $( $(#[$command_attr])* $command_variant, )*
            Message(String),
        }
        impl Command {
            fn registration(&self) -> &'static Registration {
                match self {
                    $( $(#[$tab_attr])* Self::$variant { .. } => &$module::REGISTRATION, )*
                    $( $(#[$command_attr])* Self::$command_variant => &$command_module::REGISTRATION, )*
                    Self::Message(_) => &session::REGISTRATION,
                }
            }
            fn label(&self, sessions: &[Session]) -> String {
                match self {
                    Self::Session(id) => session::label(id, sessions),
                    Self::Message(_) => "New message in selected session".into(),
                    _ => self.registration().command_label.into(),
                }
            }
        }
        enum Content { $( $(#[$tab_attr])* $variant(Entity<$module::View>), )* }
        impl Content {
            fn element(&self) -> gpui::AnyElement {
                match self { $( $(#[$tab_attr])* Self::$variant(view) => view.clone().into_any_element(), )* }
            }
            fn focus(&self, composer: bool, window: &mut Window, cx: &mut Context<Shell>) {
                match self { $( $(#[$tab_attr])* Self::$variant(view) => <$module::View as ShellView>::focus(view, composer, window, cx), )* }
            }
            fn tick(&self, refresh: bool, cx: &mut Context<Shell>) {
                match self { $( $(#[$tab_attr])* Self::$variant(view) => <$module::View as ShellView>::tick(view, refresh, cx), )* }
            }
            #[cfg(test)]
            fn ready(&self, cx: &App) -> bool {
                match self { $( $(#[$tab_attr])* Self::$variant(view) => <$module::View as ShellView>::ready(view, cx), )* }
            }
        }
        #[derive(Default)]
        #[allow(dead_code)] // Stateless surfaces reserve a typed runtime slot for future ports.
        struct SurfaceRuntime {
            $( $(#[$tab_attr])* $module: $module::Runtime, )*
            $( $(#[$command_attr])* $command_module: $command_module::Runtime, )*
        }
        #[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
        pub struct WorkspaceState {
            $( $(#[$tab_attr])* #[serde(flatten)] pub $module: $module::Slice, )*
            $( $(#[$command_attr])* #[serde(flatten)] pub $command_module: $command_module::Slice, )*
        }
        fn registrations() -> &'static [&'static Registration] {
            &[
                $( $(#[$tab_attr])* &$module::REGISTRATION, )*
                $( $(#[$command_attr])* &$command_module::REGISTRATION, )*
            ]
        }
    };
}
pub(super) use register_surfaces;
