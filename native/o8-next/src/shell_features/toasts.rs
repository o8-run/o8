// Shell toast host and the imperative API shared by surfaces.
use super::*;
use gpui::{Global, SharedString};
use std::time::Instant;
#[path = "toasts/view.rs"]
mod view;

pub(crate) type ToastId = u64;
pub(crate) const NOTICE_TIMEOUT: Duration = Duration::from_millis(5200);
pub(crate) const ERROR_TIMEOUT: Duration = Duration::from_secs(12);
pub(crate) const CHAT_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_VISIBLE: usize = 4;

#[derive(Clone)]
pub(crate) enum Kind {
    Info,
    Success,
    Confirm,
    Error { detail: SharedString },
    SpawnError { detail: SharedString },
    Chat,
}
impl Kind {
    fn detail(&self) -> Option<&SharedString> {
        match self {
            Self::Error { detail } | Self::SpawnError { detail } if !detail.is_empty() => {
                Some(detail)
            }
            _ => None,
        }
    }
    fn place(&self) -> u8 {
        match self {
            Self::SpawnError { .. } => 1,
            Self::Chat => 2,
            _ => 0,
        }
    }
    fn urgent(&self) -> bool {
        matches!(self, Self::Confirm | Self::Error { .. })
    }
}
type Callback = Box<dyn FnOnce(&mut Window, &mut App)>;
pub(crate) struct Action {
    label: SharedString,
    callback: Option<Callback>,
}
impl Action {
    pub(crate) fn new(
        label: impl Into<SharedString>,
        callback: impl FnOnce(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            callback: Some(Box::new(callback)),
        }
    }
}
struct Toast {
    id: ToastId,
    kind: Kind,
    text: SharedString,
    actions: Vec<Action>,
    entered: Instant,
    exiting: Option<(Instant, f32)>,
    deadline: Option<Instant>,
    paused: Option<Duration>,
    expanded: bool,
}
impl Toast {
    fn opacity(&self, now: Instant) -> (f32, bool) {
        let (elapsed, duration, from) = if let Some((at, from)) = self.exiting {
            (
                now.saturating_duration_since(at),
                crate::motion::TOAST_EXIT_MS,
                Some(from),
            )
        } else {
            (
                now.saturating_duration_since(self.entered),
                crate::motion::TOAST_ENTER_MS,
                None,
            )
        };
        let progress = (elapsed.as_secs_f32() * 1000. / duration as f32).min(1.);
        let eased = crate::motion::ease_out(progress);
        (
            from.map_or(eased, |from| from * (1. - eased)),
            progress < 1.,
        )
    }
}
#[derive(Default)]
struct Center {
    next: ToastId,
    items: Vec<Toast>,
}
impl Global for Center {}

/// `None` disables the timeout; the four-item capacity still applies. Actions run once,
/// after dismissal starts, and may freely show another toast or update a surface.
pub(crate) fn show(
    kind: Kind,
    text: impl Into<SharedString>,
    actions: Vec<Action>,
    timeout: Option<Duration>,
    cx: &mut App,
) -> ToastId {
    let now = cx.background_executor().now();
    let (id, evict) = {
        let center = cx.default_global::<Center>();
        center.next += 1;
        let id = center.next;
        let evict = if center.items.iter().filter(|t| t.exiting.is_none()).count() >= MAX_VISIBLE {
            center
                .items
                .iter()
                .find(|t| t.exiting.is_none())
                .map(|t| t.id)
        } else {
            None
        };
        center.items.push(Toast {
            id,
            kind,
            text: text.into(),
            actions,
            entered: now,
            exiting: None,
            deadline: timeout.map(|t| now + t),
            paused: None,
            expanded: false,
        });
        (id, evict)
    };
    if let Some(id) = evict {
        dismiss(id, cx);
    }
    arm(id, cx);
    id
}
pub(crate) fn dismiss(id: ToastId, cx: &mut App) {
    let now = cx.background_executor().now();
    if let Some(toast) = cx
        .default_global::<Center>()
        .items
        .iter_mut()
        .find(|t| t.id == id && t.exiting.is_none())
    {
        let opacity = toast.opacity(now).0;
        toast.exiting = Some((now, opacity));
        toast.deadline = None;
        toast.paused = None;
        for action in &mut toast.actions {
            action.callback = None;
        }
    } else {
        return;
    }
    arm(id, cx);
}
fn arm(id: ToastId, cx: &mut App) {
    let now = cx.background_executor().now();
    let next = cx
        .try_global::<Center>()
        .and_then(|c| c.items.iter().find(|t| t.id == id))
        .and_then(|t| {
            t.exiting
                .map(|(at, _)| at + Duration::from_millis(crate::motion::TOAST_EXIT_MS))
                .or(t.deadline)
        });
    let Some(next) = next else {
        return;
    };
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(next.saturating_duration_since(now))
            .await;
        let _ = cx.update(|cx| {
            let now = cx.background_executor().now();
            let Some(toast) = cx
                .try_global::<Center>()
                .and_then(|c| c.items.iter().find(|t| t.id == id))
            else {
                return;
            };
            if toast.exiting.is_some_and(|(at, _)| {
                now.saturating_duration_since(at)
                    >= Duration::from_millis(crate::motion::TOAST_EXIT_MS)
            }) {
                cx.global_mut::<Center>().items.retain(|t| t.id != id);
            } else if toast.exiting.is_none() && toast.deadline.is_some_and(|at| at <= now) {
                dismiss(id, cx);
            }
        });
    })
    .detach();
}
fn pause(id: ToastId, hover: bool, cx: &mut App) {
    let now = cx.background_executor().now();
    let Some(toast) = cx
        .default_global::<Center>()
        .items
        .iter_mut()
        .find(|t| t.id == id && t.exiting.is_none())
    else {
        return;
    };
    if hover {
        if let Some(deadline) = toast.deadline.take() {
            toast.paused = Some(deadline.saturating_duration_since(now));
        }
    } else if let Some(remaining) = toast.paused.take() {
        toast.deadline = Some(now + remaining);
        arm(id, cx);
    }
}
fn fire(id: ToastId, index: usize, window: &mut Window, cx: &mut App) {
    let action = cx
        .default_global::<Center>()
        .items
        .iter_mut()
        .find(|t| t.id == id && t.exiting.is_none())
        .and_then(|t| t.actions.get_mut(index))
        .and_then(|a| a.callback.take());
    if let Some(action) = action {
        dismiss(id, cx);
        action(window, cx);
    }
}
fn detail(id: ToastId, cx: &mut App) {
    if let Some(toast) = cx
        .default_global::<Center>()
        .items
        .iter_mut()
        .find(|t| t.id == id && t.exiting.is_none())
    {
        toast.expanded = !toast.expanded;
    }
}
// Convenience for shell callers; surfaces can use show directly.
pub(super) fn info(text: impl Into<SharedString>, cx: &mut App) -> ToastId {
    show(Kind::Info, text, vec![], Some(NOTICE_TIMEOUT), cx)
}
pub(super) fn error(text: impl Into<SharedString>, cx: &mut App) -> ToastId {
    let text: SharedString = text.into();
    let (message, detail) = text
        .split_once('\n')
        .map_or((text.as_ref(), ""), |(message, detail)| (message, detail));
    show(
        Kind::Error {
            detail: detail.to_owned().into(),
        },
        message.to_owned(),
        vec![],
        Some(ERROR_TIMEOUT),
        cx,
    )
}
#[cfg(test)]
pub(crate) fn texts(cx: &App) -> Vec<String> {
    cx.try_global::<Center>().map_or_else(Vec::new, |c| {
        c.items
            .iter()
            .filter(|t| t.exiting.is_none())
            .map(|t| t.text.to_string())
            .collect()
    })
}
struct Toasts;
register_shell_feature!(Toasts);
impl ShellFeature for Toasts {
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: 90,
            install: |s, _, cx| {
                s.subscriptions
                    .push(cx.observe_global::<Center>(|_, cx| cx.notify()));
            },
        }]
    }
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Content,
            order: 940,
            render: view::render,
        }]
    }
}
