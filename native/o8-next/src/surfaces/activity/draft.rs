//! The classic Accept handoff: a local, unsent orchestrator draft.
use super::*;
pub(super) fn open(
    s: &mut Shell,
    repo: &str,
    text: &str,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    let sessions = s
        .sessions
        .iter()
        .filter(|session| {
            !session.packet_state
                && session.packet_header.is_none()
                && session.backend.is_some()
                && session.tmux_session.is_none()
                && session.repo_path.as_deref() == Some(repo)
        })
        .collect::<Vec<_>>();
    let retained = s.current().and_then(|w| {
        w.tabs.iter().rev().find_map(|tab| {
            if let Tab::Session(id) = tab {
                sessions
                    .iter()
                    .find(|session| session.id == *id)
                    .map(|session| session.id.clone())
            } else {
                None
            }
        })
    });
    if let Some(id) = retained.or_else(|| sessions.first().map(|session| session.id.clone())) {
        place(s, repo, &id, text, window, cx);
        return;
    }
    if repo.is_empty() || repo == "*" {
        s.notice = "Directive saved. Select a repository conversation to review the draft.".into();
        cx.notify();
        return;
    }
    let id = format!(
        "thoughts-next-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let client = s.client.in_workspace(repo);
    let (target, thread) = (repo.to_owned(), id.clone());
    let task=cx.background_executor().spawn(async move {
        let url=client.url("/api/v2/chat-history").map_err(|e|e.to_string())?;
        client.request("POST",&url).send_json(serde_json::json!({"tabId":thread,"messages":[],"repoPath":target,"repoName":target.rsplit('/').next().unwrap_or(""),"title":"Review proposed directive"})).map_err(|_|"Could not prepare the directive review conversation.".to_owned())?;
        client.sessions()
    });
    let text = text.to_owned();
    let repo = repo.to_owned();
    cx.spawn_in(window,async move |this,cx| {
        let result=task.await;
        let _=this.update_in(cx,|s,window,cx| {
            match result {
                Ok(sessions) if sessions.iter().any(|session|session.id==id)=> {
                    s.sessions=sessions;
                    place(s,&repo,&id,&text,window,cx);
                }
                _=>s.notice="Directive saved, but its review conversation could not be opened. Open a conversation and retry the draft handoff.".into(),
            }
            cx.notify();
        });
    }).detach();
}
fn place(
    s: &mut Shell,
    repo: &str,
    id: &str,
    text: &str,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    if s.state.selected.as_deref() != Some(repo) {
        s.switch(repo.to_owned(), window, cx);
    }
    s.execute(Command::Session(id.to_owned()), window, cx);
    if let Some(Content::Session(view)) = s.content.get(&s.key(&Tab::Session(id.to_owned()))) {
        view.update(cx, |surface, cx| surface.prepend_draft(text, window, cx));
    }
}
