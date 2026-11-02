//! Threads from other machines, read through each machine's own tunnel and
//! listed beside this computer's. Off unless `O8_NEXT_MACHINE_THREADS` is set,
//! until every panel follows the thread's machine.
use crate::client::{Client, Session};
pub(crate) use crate::shell::settings::machine_links::Links;
use crate::shell::settings::machine_links::{Machine, Reach};
use crate::shell::settings::machines::{SSH_MACHINES, machine_window::Route};
use serde_json::Value;
use std::time::Duration;

pub(crate) fn enabled() -> bool {
    !cfg!(test) && std::env::var("O8_NEXT_MACHINE_THREADS").is_ok_and(|value| value == "1")
}

/// How often far machines are read; they have no live feed here yet.
pub(super) const READ_GAP: Duration = Duration::from_secs(15);

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

/// What one read of the saved machines found.
#[derive(Default)]
pub(super) struct Reading {
    pub sessions: Vec<Session>,
    /// Machines that gave no answer: their rows stay, marked when it's known
    /// they're offline, because a dropped tunnel doesn't end their threads.
    pub silent: Vec<(String, Option<String>)>,
}

/// Every saved machine's threads, read side by side so a slow tunnel only
/// delays itself. Runs apart from this computer's own list.
pub(super) fn read(client: &Client, links: &Links) -> Reading {
    if let Ok(saved) = client.get::<Value>(SSH_MACHINES, &[]) {
        links.sync(routes(&saved));
    }
    let mut reading = Reading::default();
    let answers: Vec<_> = std::thread::scope(|scope| {
        let reads: Vec<_> = links
            .machines()
            .into_iter()
            .map(|machine| scope.spawn(move || answer(machine)))
            .collect();
        reads
            .into_iter()
            .filter_map(|read| read.join().ok())
            .collect()
    });
    for (machine, list) in answers {
        match list {
            Some(list) => reading.sessions.extend(list),
            None => reading.silent.push(machine),
        }
    }
    reading
}

fn answer(machine: Machine) -> ((String, Option<String>), Option<Vec<Session>>) {
    let offline = format!("{} · offline", machine.label);
    match machine.reach {
        Reach::Online(remote) => {
            let list = remote
                .sidebar_sessions_with_branches()
                .ok()
                .map(|(list, _)| {
                    list.into_iter()
                        .map(|mut session| {
                            session.machine = Some(machine.id.clone());
                            session.machine_label = Some(machine.label.clone());
                            session
                        })
                        .collect()
                });
            ((machine.id, None), list)
        }
        Reach::Connecting => ((machine.id, None), None),
        Reach::Offline(_) => ((machine.id, Some(offline)), None),
    }
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
