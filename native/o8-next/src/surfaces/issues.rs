use super::*;
use serde_json::Value;

pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = crate::issues::Issues;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((7, || Command::Issues)),
    create: |shell, _, workspace, window, cx| {
        Some(Content::Issues(cx.new(|cx| {
            crate::issues::Issues::new(shell.client.clone(), Some(workspace.clone()), window, cx)
        })))
    },
    ..Registration::new("Issues", "Open issues", |_, _, _, _| {
        Some((Tab::Issues, false))
    })
};
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus(window, cx);
    }
    fn tick(view: &Entity<Self>, refresh: bool, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.tick(refresh, cx));
    }
    #[cfg(test)]
    fn ready(_: &Entity<Self>, _: &App) -> bool {
        false
    }
}

// Request adapters compile with this surface through its existing shell entry.
impl Client {
    /// Desktop issue contracts, with the same operator credential as other native reads.
    pub(crate) fn issue_request(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value, crate::issues::IssueError> {
        use crate::issues::IssueError;
        let mut url = self
            .url(path)
            .map_err(|_| IssueError::from("Invalid issue route".to_owned()))?;
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        let request = self.request(method, &url);
        let result = if let Some(body) = body {
            request.send_json(body)
        } else {
            request.call()
        };
        let response = match result {
            Ok(response) => response,
            Err(ureq::Error::Status(status, response)) => {
                let retry_after = response
                    .header("Retry-After")
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                let value = Self::read::<Value>(response).unwrap_or(Value::Null);
                return Err(IssueError {
                    message: format!(
                        "HTTP {status}: {}",
                        value["error"].as_str().unwrap_or("Issue request refused")
                    ),
                    retry_after,
                    creation_refused: value["creationRefused"] == true,
                });
            }
            Err(_) => {
                return Err(IssueError::from(
                    "Could not reach the selected server. Draft retained.".to_owned(),
                ));
            }
        };
        let value: Value = Self::read(response).map_err(IssueError::from)?;
        // Broker lists may contain a usable stale snapshot alongside an error.
        if !value["issues"].is_array()
            && let Some(error) = value["error"].as_str()
        {
            return Err(IssueError::from(error.to_owned()));
        }
        Ok(value)
    }
}

#[cfg(test)]
#[path = "../issue_tests.rs"]
mod tests;
