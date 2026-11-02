use super::*;
use crate::inbox::ReplyContext;
use std::time::Instant;
#[derive(Default)]
struct Replies {
    waiting: Option<(String, ReplyContext, Instant)>,
}
struct InboxReplies;
register_shell_feature!(InboxReplies);
impl ShellFeature for InboxReplies {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 55,
            run: |s, _, w, cx| {
                let Some((id, request, deadline)) = s.features.get::<Replies>().waiting.take()
                else {
                    return;
                };
                if s.sessions.iter().any(|session| session.id == id) {
                    finish(s, id, request, w, cx);
                } else if Instant::now() >= deadline {
                    toasts::info(
                        "The reply conversation could not be opened. Refresh and choose Draft reply in chat again.",
                        cx,
                    );
                } else {
                    s.features.get::<Replies>().waiting = Some((id, request, deadline));
                }
            },
        }]
    }
}
impl Shell {
    pub(crate) fn inbox_prepare_reply(
        &mut self,
        request: ReplyContext,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.features.get::<Replies>().waiting.is_some() {
            toasts::info(
                "A reply conversation is still opening. Try again when it is ready.",
                cx,
            );
            return;
        }
        let linked = self
            .sessions
            .iter()
            .find(|session| session.key() == request.session || session.id == request.session)
            .cloned();
        let workspace = linked
            .as_ref()
            .and_then(|session| session.repo_path.clone())
            .or_else(|| {
                request
                    .repo_paths
                    .iter()
                    .find(|path| {
                        self.state
                            .selected
                            .as_ref()
                            .is_some_and(|selected| crate::client::same_workspace(path, selected))
                    })
                    .cloned()
            })
            .or_else(|| request.repo_paths.first().cloned());
        let Some(workspace) = workspace else {
            toasts::info(
                "This inbox item has no local workspace. Open its repository and refresh the Inbox before drafting.",
                cx,
            );
            return;
        };
        let writable = |session: &Session| {
            !session.id.contains(':')
                && !session.id.starts_with("thoughts-side-chat-")
                && session
                    .repo_path
                    .as_ref()
                    .is_some_and(|path| crate::client::same_workspace(path, &workspace))
        };
        let shown = self
            .active()
            .and_then(|tab| self.content.get(&self.key(&tab)))
            .and_then(|content| match content {
                Content::Session(view) => view.read(cx).shown_thread(),
                _ => None,
            });
        let id = linked
            .filter(writable)
            .map(|session| session.id)
            .or_else(|| {
                self.sessions
                    .iter()
                    .find(|session| writable(session) && Some(&session.id) == shown.as_ref())
                    .map(|session| session.id.clone())
            })
            .or_else(|| {
                self.sessions
                    .iter()
                    .find(|session| writable(session))
                    .map(|session| session.id.clone())
            });
        if self.state.selected.as_ref() != Some(&workspace) {
            self.switch(workspace, w, cx);
        }
        if let Some(id) = id {
            finish(self, id, request, w, cx);
        } else if let Some(id) = self.start_thread(false, cx) {
            self.features.get::<Replies>().waiting =
                Some((id, request, Instant::now() + Duration::from_secs(30)));
            toasts::info(
                "Opening a conversation for this inbox item. Its draft will remain unsent.",
                cx,
            );
        } else {
            toasts::info("Open this item's workspace before drafting a reply.", cx);
        }
    }
}
fn finish(
    s: &mut Shell,
    id: String,
    request: ReplyContext,
    w: &mut Window,
    cx: &mut Context<Shell>,
) {
    let Some(workspace) = s
        .sessions
        .iter()
        .find(|session| session.id == id)
        .and_then(|session| session.repo_path.clone())
    else {
        return;
    };
    if s.state.selected.as_ref() != Some(&workspace) {
        s.switch(workspace, w, cx);
    }
    s.execute(Command::Session(id.clone()), w, cx);
    let surface = match s.content.get(&s.key(&Tab::Session(id.clone()))) {
        Some(Content::Session(surface)) => surface.clone(),
        _ => {
            toasts::info(
                "The reply conversation is unavailable. Refresh and retry.",
                cx,
            );
            return;
        }
    };
    surface.update(cx, |surface, cx| {
        surface.shell_open(id, cx);
        surface.prepend_inbox_draft(&request.prompt, w, cx);
    });
    s.capture(w, cx);
    s.persist();
    toasts::info(
        "Inbox context added to chat. Review the unsent draft there.",
        cx,
    );
    cx.notify();
}
