//! Threads from other machines, read through each machine's own tunnel and
//! listed beside this computer's. Off unless `O8_NEXT_MACHINE_THREADS` is set,
//! until every panel follows the thread's machine.
use crate::client::{Client, Session};
pub(crate) use crate::shell::settings::machine_links::Links;
use crate::shell::settings::machine_links::Reach;
use crate::shell::settings::machines::{SSH_MACHINES, machine_window::Route};
use serde_json::Value;
use std::time::Duration;

pub(crate) fn enabled() -> bool {
    !cfg!(test) && std::env::var("O8_NEXT_MACHINE_THREADS").is_ok_and(|value| value == "1")
}

/// How long a list may sit before it's read again. Far machines have no live
/// feed here yet, so their rows and any tunnel that just came up wait on this.
pub(super) fn reload_gap() -> Duration {
    Duration::from_secs(if enabled() { 15 } else { 300 })
}

/// The saved machines worth a tunnel, with their labels.
fn routes(saved: &Value) -> Vec<(Route, String)> {
    saved["machines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|machine| machine["enabled"] != false)
        .filter_map(|machine| {
            let label = machine["label"].as_str()?.to_owned();
            Some((Route::parse(machine)?, label))
        })
        .collect()
}

/// Every reachable machine's threads. A machine that can't answer adds nothing
/// and never fails this computer's own list.
pub(super) fn sessions(client: &Client, links: &Links) -> Vec<Session> {
    if !enabled() {
        return vec![];
    }
    if let Ok(saved) = client.get::<Value>(SSH_MACHINES, &[]) {
        links.sync(routes(&saved));
    }
    let mut sessions = vec![];
    for machine in links.machines() {
        let Reach::Online(remote) = machine.reach else {
            continue;
        };
        if let Ok((list, _)) = remote.sidebar_sessions_with_branches() {
            sessions.extend(list.into_iter().map(|mut session| {
                session.machine = Some(machine.id.clone());
                session.machine_label = Some(machine.label.clone());
                session
            }));
        }
    }
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_disabled_machine_gets_no_tunnel() {
        let saved = json!({"machines":[
            {"id":"a","label":"Box","target":"box","port":22,"enabled":true},
            {"id":"b","label":"Off","target":"off","port":22,"enabled":false}
        ]});
        let routes = routes(&saved);
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].1, "Box");
    }
}
