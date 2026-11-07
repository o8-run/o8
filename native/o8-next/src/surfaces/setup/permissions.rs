//! The desktop's optional voice step (OnboardingPermissionsStep.tsx), with
//! its permission checks (permissions-check.ts, permissions-model.ts) and
//! Symon's marks (SymonVisuals.tsx). The macOS checks are the desktop app's
//! (src-tauri/src/mac_perms.rs): reading never prompts; Allow… asks macOS
//! only where the desktop does, and otherwise opens System Settings.
use super::look::{self, Look};
use super::{Setup, Step};
use crate::theme::current as theme;
use gpui::{Context, Div, FontWeight, PathBuilder, canvas, div, point, prelude::*, px, relative};
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Perm {
    Microphone,
    Accessibility,
    InputMonitoring,
    ScreenRecording,
}
pub(crate) const ALL: [Perm; 4] = [
    Perm::Microphone,
    Perm::Accessibility,
    Perm::InputMonitoring,
    Perm::ScreenRecording,
];
/// What macOS reports. Only the microphone can say it never asked.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Status {
    Granted,
    Denied,
    NotAsked,
    Unknown,
}
pub(crate) type Snapshot = [Status; 4];
pub(crate) const EMPTY: Snapshot = [Status::Unknown; 4];

impl Perm {
    fn index(self) -> usize {
        ALL.iter().position(|p| *p == self).unwrap_or(0)
    }
    fn label(self) -> &'static str {
        match self {
            Perm::Microphone => "Microphone",
            Perm::Accessibility => "Accessibility",
            Perm::InputMonitoring => "Input Monitoring",
            Perm::ScreenRecording => "Screen Recording",
        }
    }
    /// The step's own reason line, as on the desktop.
    fn reason(self) -> &'static str {
        match self {
            Perm::Microphone => "Talk to Symon and dictate in o8.",
            Perm::Accessibility => "Dictate into another app and use desktop controls.",
            Perm::InputMonitoring => "Use voice shortcuts while another app is focused.",
            Perm::ScreenRecording => "Let screen-aware features see your screen when you use them.",
        }
    }
    /// The exact System Settings pane.
    pub(crate) fn settings(self) -> &'static str {
        match self {
            Perm::Microphone => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            Perm::Accessibility => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            Perm::InputMonitoring => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
            Perm::ScreenRecording => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
        }
    }
    /// Whether o8 can show macOS's own prompt for it.
    fn can_prompt(self) -> bool {
        matches!(self, Perm::Microphone | Perm::InputMonitoring)
    }
    fn id(self) -> &'static str {
        match self {
            Perm::Microphone => "microphone",
            Perm::Accessibility => "accessibility",
            Perm::InputMonitoring => "input-monitoring",
            Perm::ScreenRecording => "screen-recording",
        }
    }
}
/// fixActionLabel: Allow… only where macOS has never asked and o8 can ask.
pub(crate) fn fix_label(perm: Perm, status: Status) -> &'static str {
    if perm.can_prompt() && status == Status::NotAsked {
        "Allow…"
    } else {
        "Open Settings"
    }
}

/// Reads and requests the four permissions. Setup takes it injected, so
/// tests never reach a real macOS prompt.
pub(crate) trait Client: Send + Sync {
    fn supported(&self) -> bool;
    /// Never prompts.
    fn read(&self) -> Snapshot;
    /// requestOnboardingPermission: prompt first where the desktop does,
    /// otherwise open the permission's System Settings pane.
    fn request(&self, perm: Perm, status: Status) -> Result<(), String>;
}

/// Debug builds only: fixed statuses for real-window checks, so a check never
/// reaches a macOS prompt or System Settings. `O8_NEXT_PERMISSIONS_FIXTURE`
/// lists the four statuses in Perm order (granted, denied, not-asked or
/// unknown); a trailing `hold` keeps a request open.
#[cfg(debug_assertions)]
pub(crate) struct Fixture {
    snapshot: Snapshot,
    hold: bool,
}
#[cfg(debug_assertions)]
impl Fixture {
    pub(crate) fn from_env() -> Option<Self> {
        Self::parse(&std::env::var("O8_NEXT_PERMISSIONS_FIXTURE").ok()?)
    }
    fn parse(value: &str) -> Option<Self> {
        let mut parts = value.split(',').map(str::trim);
        let mut snapshot = EMPTY;
        for slot in &mut snapshot {
            *slot = match parts.next()? {
                "granted" => Status::Granted,
                "denied" => Status::Denied,
                "not-asked" => Status::NotAsked,
                "unknown" => Status::Unknown,
                _ => return None,
            };
        }
        let hold = match parts.next() {
            None => false,
            Some("hold") => true,
            Some(_) => return None,
        };
        Some(Self { snapshot, hold })
    }
}
#[cfg(debug_assertions)]
impl Client for Fixture {
    fn supported(&self) -> bool {
        true
    }
    fn read(&self) -> Snapshot {
        self.snapshot
    }
    fn request(&self, _: Perm, _: Status) -> Result<(), String> {
        if self.hold {
            std::thread::sleep(Duration::from_secs(600));
        }
        Ok(())
    }
}

/// The running Mac.
pub(crate) struct Native;
impl Client for Native {
    fn supported(&self) -> bool {
        cfg!(target_os = "macos")
    }
    fn read(&self) -> Snapshot {
        #[cfg(target_os = "macos")]
        {
            let flag = |granted: bool| {
                if granted {
                    Status::Granted
                } else {
                    Status::Denied
                }
            };
            [
                match mac::microphone() {
                    Some(true) => Status::Granted,
                    Some(false) => Status::Denied,
                    None => Status::NotAsked,
                },
                flag(mac::accessibility()),
                flag(mac::input_monitoring(false)),
                flag(mac::screen_recording()),
            ]
        }
        #[cfg(not(target_os = "macos"))]
        EMPTY
    }
    fn request(&self, perm: Perm, status: Status) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            if perm == Perm::Microphone && status == Status::NotAsked {
                mac::request_microphone();
                return Ok(());
            }
            if perm == Perm::InputMonitoring && mac::input_monitoring(true) {
                return Ok(());
            }
            std::process::Command::new("open")
                .arg(perm.settings())
                .spawn()
                .map(|_| ())
                .map_err(|_| "Could not open permissions. Try again.".to_owned())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (perm, status);
            Err("Open o8 on macOS to check these permissions.".into())
        }
    }
}

/// The desktop app's macOS checks, from src-tauri/src/mac_perms.rs.
#[cfg(target_os = "macos")]
mod mac {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{msg_send, runtime::Class, sel, sel_impl};

    // tree-sitter-rust 0.24 (theme_tests) cannot parse `unsafe extern "C"` blocks,
    // so the declarations reach the parser only as macro token trees.
    macro_rules! permission_abi {
        ($(#[$meta:meta])* { $($declaration:tt)* }) => {
            $(#[$meta])* unsafe extern "C" { $($declaration)* }
        };
    }
    permission_abi! {
        #[link(name = "AVFoundation", kind = "framework")]
        {}
    }
    permission_abi! {
        #[link(name = "ApplicationServices", kind = "framework")]
        {
            fn AXIsProcessTrusted() -> bool;
        }
    }
    permission_abi! {
        #[link(name = "IOKit", kind = "framework")]
        {
            fn IOHIDCheckAccess(request: u32) -> u32;
            fn IOHIDRequestAccess(request: u32) -> bool;
        }
    }
    permission_abi! {
        #[link(name = "CoreGraphics", kind = "framework")]
        {
            fn CGPreflightScreenCaptureAccess() -> bool;
        }
    }

    /// AVMediaTypeAudio.
    fn audio() -> id {
        unsafe {
            let media = NSString::alloc(nil).init_str("soun");
            let _: id = msg_send![media, autorelease];
            media
        }
    }
    /// Some(true) authorized, Some(false) denied or restricted, None never asked.
    pub(super) fn microphone() -> Option<bool> {
        let class = Class::get("AVCaptureDevice")?;
        let status: isize = unsafe { msg_send![class, authorizationStatusForMediaType: audio()] };
        match status {
            3 => Some(true),
            0 => None,
            _ => Some(false),
        }
    }
    /// macOS's microphone prompt; it shows only while the answer is unasked.
    pub(super) fn request_microphone() {
        let Some(class) = Class::get("AVCaptureDevice") else {
            return;
        };
        let done = block::ConcreteBlock::new(|_granted: objc::runtime::BOOL| {}).copy();
        let _: () = unsafe {
            msg_send![class, requestAccessForMediaType: audio() completionHandler: &*done]
        };
    }
    pub(super) fn accessibility() -> bool {
        unsafe { AXIsProcessTrusted() }
    }
    /// kIOHIDRequestTypeListenEvent; `prompt` shows macOS's prompt.
    pub(super) fn input_monitoring(prompt: bool) -> bool {
        unsafe {
            if prompt {
                IOHIDRequestAccess(1)
            } else {
                IOHIDCheckAccess(1) == 0
            }
        }
    }
    pub(super) fn screen_recording() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }
}

/// SymonWaveform at rest: 30 bars under a centred bell, in Symon's colours.
fn waveform(level: f32, width: f32) -> Div {
    const BARS: usize = 30;
    let scale = width / 132.5;
    let center = (BARS - 1) as f32 / 2.;
    div()
        .h(px(24.))
        .w(px(width))
        .flex()
        .items_center()
        .gap(px(2.5 * scale))
        .children((0..BARS).map(|i| {
            let weight = (-1.8 * ((i as f32 - center).abs() / center).powi(2)).exp();
            div()
                .w(px(2. * scale))
                .h(px((level * weight * 24.).max(2.)))
                .rounded(px(1.))
                .bg(crate::theme::symon_color(i as f32 / (BARS - 1) as f32))
        }))
}
/// SymonPolishMark at rest: the polishing stroke, in the palette's middle.
fn polish_mark() -> impl IntoElement {
    const WIDTH: f32 = 42.;
    canvas(
        |_, _, _| (),
        |bounds, _, window, _| {
            let scale = WIDTH / 416.;
            let at = |x: f32, y: f32| {
                bounds.origin + point(px(x * scale), px(y * scale + (18. - 52. * scale) / 2.))
            };
            let mut path = PathBuilder::stroke(px(12. * scale));
            path.move_to(at(8., 28.));
            for [a, b, c] in [
                [(32., 22.), (48., 14.), (72., 14.)],
                [(96., 14.), (108., 34.), (132., 34.)],
                [(156., 34.), (170., 12.), (198., 12.)],
                [(230., 12.), (238., 38.), (272., 38.)],
                [(304., 38.), (316., 18.), (344., 18.)],
                [(372., 18.), (388., 28.), (408., 28.)],
            ] {
                path.cubic_bezier_to(at(c.0, c.1), at(a.0, a.1), at(b.0, b.1));
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, crate::theme::symon_color(0.42));
            }
        },
    )
    .w(px(WIDTH))
    .h(px(18.))
}

/// OnboardingReady: the green "Ready" pill.
fn ready(perm: Perm) -> Div {
    div()
        .debug_selector(move || format!("setup-permission-{}-ready", perm.id()))
        .flex_none()
        .flex()
        .items_center()
        .gap(px(7.))
        .min_h(px(32.))
        .py(px(4.))
        .pl(px(11.))
        .pr(px(12.))
        .rounded(px(20.))
        .border_1()
        .border_color(theme().success)
        .bg(theme().success_surface)
        .text_color(theme().success)
        .text_size(px(11.))
        .child(crate::icon::stroke(
            "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 12l2.5 2.5L16 9",
            theme().success,
            16.,
            1.8,
        ))
        .child("Ready")
}

impl Setup {
    /// Swap the permission checks, so tests never reach macOS.
    #[cfg(test)]
    pub fn set_permission_client(&mut self, client: std::sync::Arc<dyn Client>) {
        self.permission_client = client;
    }
    /// Read the permissions now and every 1.5 s while this step is open,
    /// off the UI thread.
    pub(super) fn watch_permissions(&mut self, cx: &mut Context<Self>) {
        self.permission_generation += 1;
        let generation = self.permission_generation;
        let client = self.permission_client.clone();
        if !client.supported() {
            return;
        }
        cx.spawn(async move |this, cx| {
            loop {
                let reader = client.clone();
                let next = cx
                    .background_executor()
                    .spawn(async move { reader.read() })
                    .await;
                let open = this
                    .update(cx, |this, cx| {
                        if this.step != Step::Permissions
                            || this.permission_generation != generation
                        {
                            return false;
                        }
                        if this.permissions != next || !this.permissions_checked {
                            this.permissions = next;
                            this.permissions_checked = true;
                            this.revision += 1;
                            cx.notify();
                        }
                        true
                    })
                    .unwrap_or(false);
                if !open {
                    return;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(1_500))
                    .await;
            }
        })
        .detach();
    }
    fn fix_permission(&mut self, perm: Perm, cx: &mut Context<Self>) {
        if self.permission_busy.is_some() {
            return;
        }
        self.permission_busy = Some(perm);
        self.permission_error = None;
        let client = self.permission_client.clone();
        let status = self.permissions[perm.index()];
        let task = cx
            .background_executor()
            .spawn(async move { client.request(perm, status) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.permission_busy = None;
                this.permission_error = result.err();
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
        self.revision += 1;
        cx.notify();
    }

    fn permission_row(&self, perm: Perm, cx: &mut Context<Self>) -> Div {
        let status = self.permissions[perm.index()];
        let checked = self.permissions_checked;
        let busy = self.permission_busy.is_some();
        div()
            .debug_selector(move || format!("setup-permission-{}", perm.id()))
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(12.))
            .py(px(12.))
            .child(
                div()
                    .flex_1()
                    .min_w(px(200.))
                    .child(div().text_size(px(13.5)).child(perm.label()))
                    .child(
                        div()
                            .mt(px(4.))
                            .text_size(px(11.))
                            .line_height(relative(1.5))
                            .text_color(theme().text_muted)
                            .child(perm.reason()),
                    ),
            )
            .when(status == Status::Granted, |v| v.child(ready(perm)))
            .when(status != Status::Granted, |v| {
                v.child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_secondary)
                        .child(if !checked {
                            "Checking…"
                        } else if status == Status::Unknown {
                            "Not verified"
                        } else {
                            "Not enabled"
                        }),
                )
                .child(
                    look::button(
                        &format!("setup-permission-{}-fix", perm.id()),
                        if self.permission_busy == Some(perm) {
                            "Opening…"
                        } else {
                            fix_label(perm, status)
                        },
                        !busy && checked,
                        Look::Bordered,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.permissions_checked {
                            this.fix_permission(perm, cx)
                        }
                    })),
                )
            })
    }

    /// Meet Symon: the microphone first, then the optional desktop controls.
    pub(super) fn permissions_page(&self, cx: &mut Context<Self>) -> Div {
        let native = self.permission_client.supported();
        let card = || {
            div()
                .min_w_0()
                .p(px(16.))
                .rounded(px(12.))
                .border_1()
                .border_color(theme().border)
                .bg(theme().surface_raised)
        };
        let mut heading = div();
        heading
            .style()
            .text
            .get_or_insert_with(Default::default)
            .letter_spacing = Some(px(0.4));
        let page = div()
            .debug_selector(|| "setup-permissions".into())
            .w_full()
            .flex()
            .flex_col()
            .gap(px(20.))
            .font_weight(FontWeight::LIGHT)
            .child(
                div()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .child(crate::shell::rail::symon_mark_sized(32., false))
                            .child(look::title("Meet Symon.")),
                    )
                    .child(
                        div()
                            .mt(px(12.))
                            .text_size(px(13.))
                            .line_height(relative(1.6))
                            .text_color(theme().text_secondary)
                            .child(
                                "Your voice layer for o8. Speak a request or dictate text. These \
                                 permissions are optional; choose the features you want.",
                            ),
                    )
                    .child(
                        div()
                            .mt(px(16.))
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(12.))
                            .text_size(px(11.))
                            .text_color(theme().text_secondary)
                            .child(waveform(0.65, 88.))
                            .child("Dictate → Transcribe → Polish")
                            .child(polish_mark()),
                    ),
            );
        let page = if native {
            page.child(
                card()
                    .child(
                        heading
                            .text_size(px(10.))
                            .text_color(theme().text_muted)
                            .child("START WITH YOUR MICROPHONE"),
                    )
                    // The desktop's microphone test sits below this row; until it
                    // is ported, the card ends at the row with even padding.
                    .child(self.permission_row(Perm::Microphone, cx).pb_0()),
            )
            .child(
                card()
                    .bg(gpui::transparent_black())
                    .child(
                        look::button("setup-desktop-controls", "", true, Look::Quiet)
                            .w_full()
                            .px_0()
                            .justify_between()
                            .child(
                                div().child("Shortcuts & screen access").child(
                                    div()
                                        .mt(px(4.))
                                        .text_size(px(11.))
                                        .text_color(theme().text_muted)
                                        .child("Optional access for features beyond this window."),
                                ),
                            )
                            .child(if self.controls_open { "−" } else { "+" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.controls_open = !this.controls_open;
                                this.revision += 1;
                                cx.notify();
                            })),
                    )
                    .when(self.controls_open, |v| {
                        v.children(ALL[1..].iter().map(|perm| {
                            div()
                                .border_t_1()
                                .border_color(theme().border)
                                .child(self.permission_row(*perm, cx))
                        }))
                        .child(
                            div()
                                .text_size(px(11.))
                                .line_height(relative(1.5))
                                .text_color(theme().text_muted)
                                .child(
                                    "Once enabled, hold Fn to dictate or right Option to ask \
                                     Symon. Changed desktop permissions may need a restart.",
                                ),
                        )
                    }),
            )
        } else {
            page.child(
                card()
                    .debug_selector(|| "setup-permissions-unsupported".into())
                    .child(div().text_size(px(13.5)).child("Voice on your Mac"))
                    .child(
                        div()
                            .mt(px(8.))
                            .text_size(px(12.))
                            .line_height(relative(1.6))
                            .text_color(theme().text_secondary)
                            .child(
                                "Open the macOS app to check native permissions. You can keep \
                                 using coding tools here.",
                            ),
                    ),
            )
        };
        page.when_some(self.permission_error.clone(), |v, error| {
            v.child(look::feedback(
                "setup-permission-error",
                error,
                "Your setup is still here. You can retry this check or return to projects.",
                None,
            ))
        })
        .child(look::actions(
            if native {
                vec![]
            } else {
                vec![
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child("Voice setup is optional.")
                        .into_any_element(),
                ]
            },
            vec![
                super::primary(
                    "setup-permissions-done",
                    "Back to projects",
                    self.permission_busy.is_none(),
                )
                .on_click(cx.listener(|this, _, _, cx| this.navigate(Step::Projects, cx)))
                .into_any_element(),
            ],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_reads_four_statuses_and_an_optional_hold() {
        let fixture = Fixture::parse("not-asked, granted, denied, unknown, hold").unwrap();
        assert_eq!(
            fixture.read(),
            [
                Status::NotAsked,
                Status::Granted,
                Status::Denied,
                Status::Unknown
            ]
        );
        assert!(fixture.hold);
        assert!(
            !Fixture::parse("granted,granted,granted,granted")
                .unwrap()
                .hold
        );
        assert!(Fixture::parse("granted,granted,granted").is_none());
        assert!(Fixture::parse("granted,granted,granted,granted,later").is_none());
        assert!(Fixture::parse("granted,yes,granted,granted").is_none());
    }
}
