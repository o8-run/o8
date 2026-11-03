//! Threads from other machines, read through each machine's own tunnel and
//! listed beside this computer's. Off unless `O8_NEXT_MACHINE_THREADS` is set,
//! until every panel follows the thread's machine.
use crate::client::{Client, Session};
use crate::shell::session::{machine_thread, machine_thread_id, reserved_thread_id};
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

/// Who owns a sidebar id. The id alone decides, and one nothing lists is
/// refused rather than sent to this computer.
#[derive(Debug, PartialEq)]
pub(super) enum Owner<'a> {
    Machine(&'a str, &'a str),
    Here(&'a str),
    Nobody(&'a str),
}

pub(super) fn owner(id: &str, listed: bool, strict: bool) -> Owner<'_> {
    match machine_thread(id) {
        Some((machine, id)) => Owner::Machine(machine, id),
        None if listed || !strict => Owner::Here(id),
        None => Owner::Nobody(id),
    }
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

/// A machine's threads and its workers, one row each: a worker that a thread
/// already stands for isn't listed twice.
fn with_workers(mut list: Vec<Session>, workers: Vec<Session>) -> Vec<Session> {
    let fresh: Vec<_> = workers
        .into_iter()
        .filter(|worker| !list.iter().any(|thread| thread.key() == worker.id))
        .collect();
    list.extend(fresh);
    list
}

fn answer(machine: Machine) -> ((String, Option<String>), Option<Vec<Session>>) {
    let offline = format!("{} · offline", machine.label);
    match machine.reach {
        Reach::Online(remote) => {
            let workers = remote.sidebar_workers().unwrap_or_default();
            let list = remote
                .sidebar_sessions_with_branches()
                .ok()
                .map(|(list, _)| {
                    with_workers(list, workers)
                        .into_iter()
                        .filter(|session| !reserved_thread_id(&session.id))
                        .map(|mut session| {
                            session.id = machine_thread_id(&machine.id, &session.id);
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
    fn a_machines_worker_is_listed_once() {
        let row = |id: &str| -> Session {
            serde_json::from_value(json!({"id":id,"title":"t","status":"idle"})).unwrap()
        };
        let list = with_workers(vec![row("a")], vec![row("codex:7")]);
        assert_eq!(list.len(), 2);
        let id = machine_thread_id("box", &list[1].id);
        assert_eq!(owner(&id, true, true), Owner::Machine("box", "codex:7"));
        let both = with_workers(vec![row("codex:7")], vec![row("codex:7")]);
        assert_eq!(both.len(), 1, "a worker already listed as a thread");
    }

    #[test]
    fn the_same_thread_id_on_two_computers_stays_two_threads() {
        let far = machine_thread_id("box", "thoughts-1");
        assert_eq!(owner(&far, true, true), Owner::Machine("box", "thoughts-1"));
        assert_eq!(owner("thoughts-1", true, true), Owner::Here("thoughts-1"));
        assert!(!far.contains(':'), "a colon marks a worker's id");
    }

    #[test]
    fn the_shell_keeps_the_server_id_and_can_name_the_sidebar_row() {
        let mut session: Session =
            serde_json::from_value(json!({"id":"thoughts-1","title":"t","status":"idle"})).unwrap();
        session.machine = Some("box".into());
        let listed = machine_thread_id("box", "thoughts-1");
        session.id = listed.clone();
        let shell = crate::shell::session::with_server_ids(&[session]);
        assert_eq!(shell[0].id, "thoughts-1");
        assert_eq!(shell[0].list_id(), listed);
    }

    #[test]
    fn a_server_thread_cannot_pose_as_a_machine_thread() {
        assert!(reserved_thread_id(&machine_thread_id("box", "thoughts-1")));
        assert!(!reserved_thread_id("thoughts-1"));
    }

    #[test]
    fn an_id_nothing_lists_goes_nowhere_while_machines_are_on() {
        assert_eq!(owner("gone", false, true), Owner::Nobody("gone"));
        assert_eq!(owner("gone", false, false), Owner::Here("gone"));
    }

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
