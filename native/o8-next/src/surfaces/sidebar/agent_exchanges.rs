use super::*;

impl ThreadList {
    pub(super) fn agent_exchange_rows(&self) -> Vec<Row> {
        if self.view() != folders::View::Inbox {
            return vec![];
        }
        let chosen = self.scope_keys();
        let repos: Vec<_> = self
            .scope_repos()
            .into_iter()
            .map(|(path, _)| path)
            .collect();
        let query = self.query.trim().to_lowercase();
        let exchanges: Vec<_> = self
            .exchanges
            .iter()
            .filter(|exchange| {
                (if !chosen.is_empty() {
                    chosen.contains(&exchange.repo)
                } else if !repos.is_empty() {
                    repos.contains(&exchange.repo)
                } else {
                    self.workspace
                        .as_ref()
                        .is_none_or(|repo| *repo == exchange.repo)
                }) && (query.is_empty()
                    || format!("{} {}", exchange.participants.join(" "), exchange.repo)
                        .to_lowercase()
                        .contains(&query))
            })
            .collect();
        if exchanges.is_empty() {
            return vec![];
        }
        let mut rows = vec![recents::header("section", "Agent exchanges", "")];
        rows.extend(exchanges.into_iter().map(|exchange| Row {
            kind: "exchange".into(),
            workspace: exchange.repo.clone(),
            id: Some(exchange.id.clone()),
            title: exchange.participants.join(" · "),
            status: "Active".into(),
            unread: false,
            running: false,
            age: String::new(),
            branch: false,
            attention: false,
            marker: "",
            folder: None,
        }));
        rows
    }
    pub fn choose(&mut self, id: String, cx: &mut Context<Self>) {
        if !self.rows.iter().any(|r| r.id.as_ref() == Some(&id)) {
            return;
        }
        self.edit_generation += 1;
        self.suspend_rename(cx);
        self.choice = Some(id.clone());
        self.editing = false;
        self.selected = Some(id.clone());
        // A choice made before the list carries a new thread cancels its open.
        self.pending_open = None;
        if let Some(s) = self.sessions.iter_mut().find(|s| s.id == id) {
            s.unread = false;
        }
        self.clear_woken(&id, cx);
        self.rebuild();
        if let Some(exchange) = self.exchanges.iter().find(|exchange| exchange.id == id) {
            cx.emit(Event::Exchange(crate::inbox::ExchangeSelection {
                id,
                repo: exchange.repo.clone(),
            }));
        } else {
            cx.emit(Event::Selected(id));
        }
        cx.notify();
    }
}
