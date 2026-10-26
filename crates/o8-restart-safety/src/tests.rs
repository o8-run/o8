use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn fixture() -> (PathBuf, RestartSafety, Arc<AtomicUsize>) {
    // Each test has its own probe on its test thread, before the platform cache.
    lease_owner::IDENTITY_PROBE.with(|probe| {
        probe.set(Some(|pid| {
            Some(serde_json::json!({"version":1,"platform":"fixture",
                "bootId":"fixture-boot","startId":pid.to_string()}))
        }));
    });
    let root = std::env::temp_dir().join(format!("o8-restart-safety-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let recorded = calls.clone();
    let state = RestartSafety::new(root.clone(), move || {
        recorded.fetch_add(1, Ordering::SeqCst);
    });
    (root, state, calls)
}

#[test]
fn directory_selection_ignores_blank_primary_and_anchors_relative_overrides() {
    let cwd = std::env::temp_dir().join("o8-native-cwd");
    let home = std::env::temp_dir().join("o8-test-home");
    assert_eq!(
        resolve_data_directory(Some(""), Some("legacy"), &home, &cwd).unwrap(),
        cwd.join("legacy")
    );
    assert_eq!(
        resolve_data_directory(Some(""), Some(""), &home, &cwd).unwrap(),
        home.join(".o8")
    );
    assert_eq!(
        resolve_data_directory(Some("state"), Some("legacy"), &home, &cwd).unwrap(),
        cwd.join("state")
    );
    assert_eq!(
        resolve_data_directory(Some(home.to_str().unwrap()), None, &home, Path::new("")).unwrap(),
        home
    );
}

#[test]
fn directory_selection_normalizes_dot_segments_without_crossing_the_root() {
    let cwd = std::env::temp_dir().join("o8-native-cwd");
    let home = std::env::temp_dir().join("o8-test-home");
    assert_eq!(
        resolve_data_directory(Some("./one/../state"), None, &home, &cwd).unwrap(),
        cwd.join("state")
    );
    let root = cwd.ancestors().last().unwrap();
    assert_eq!(
        resolve_data_directory(
            Some(root.join("../state").to_str().unwrap()),
            None,
            &home,
            &cwd
        )
        .unwrap(),
        root.join("state")
    );
    assert!(resolve_data_directory(Some("state"), None, &home, Path::new("")).is_err());
}

#[cfg(unix)]
#[test]
fn symlink_parent_override_uses_the_same_lexical_installer_slot() {
    let root = std::env::temp_dir().join(format!("o8-restart-root-{}", Uuid::new_v4()));
    let expected = root.join("left/state");
    let traversed = root.join("other/state");
    fs::create_dir_all(&expected).unwrap();
    fs::create_dir_all(root.join("other/tree")).unwrap();
    fs::create_dir_all(&traversed).unwrap();
    std::os::unix::fs::symlink(root.join("other/tree"), root.join("left/link")).unwrap();
    fs::write(
        expected.join("codex-cli-update.lock"),
        "installer at Node's lexical root",
    )
    .unwrap();
    let selected = root.join("left/link/../state");
    let resolved =
        resolve_data_directory(Some(selected.to_str().unwrap()), None, &root, &root).unwrap();
    assert_eq!(resolved, expected);
    let calls = Arc::new(AtomicUsize::new(0));
    let recorded = calls.clone();
    let state = RestartSafety::new(resolved, move || {
        recorded.fetch_add(1, Ordering::SeqCst);
    });
    assert!(state.before_restart(None).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!traversed.join(DIRECTORY).exists());
    assert_eq!(
        fs::read_to_string(expected.join("codex-cli-update.lock")).unwrap(),
        "installer at Node's lexical root"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn installer_and_legacy_locks_refuse_before_child_cleanup() {
    let (root, state, calls) = fixture();
    fs::create_dir(root.join(DIRECTORY)).unwrap();
    assert!(state.before_restart(None).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    fs::remove_dir(root.join(DIRECTORY)).unwrap();
    fs::write(root.join("codex-cli-update.lock"), "legacy owner").unwrap();
    assert!(state.before_restart(None).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        fs::read_to_string(root.join("codex-cli-update.lock")).unwrap(),
        "legacy owner"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reservation_survives_checks_until_native_commit() {
    let (root, state, calls) = fixture();
    let id = state.prepare().unwrap();
    assert!(state.prepare().is_err());
    assert!(root.join(DIRECTORY).exists());
    state.before_restart(Some(&id)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(state.cancel(&id).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reservation_persists_fixture_identity_before_native_cleanup() {
    let (root, state, calls) = fixture();
    let id = state.prepare().unwrap();
    let operation = read_operation(&root.join(DIRECTORY)).unwrap();
    assert_eq!(operation.id, id);
    assert!(
        operation.owner_identity["bootId"] == "fixture-boot",
        "reservation must use the fixture probe instead of the platform probe"
    );
    assert_eq!(
        operation.owner_identity["startId"],
        std::process::id().to_string()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    state.before_restart(Some(&id)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_legacy_installer_appearing_after_prepare_refuses_before_cleanup() {
    let (root, state, calls) = fixture();
    let id = state.prepare().unwrap();
    fs::write(root.join("codex-cli-update.lock"), "later legacy owner").unwrap();
    assert!(state.before_restart(Some(&id)).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    state.cancel(&id).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("codex-cli-update.lock")).unwrap(),
        "later legacy owner"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn expired_preparation_never_runs_restart_side_effects() {
    let (root, state, calls) = fixture();
    let id = state.prepare().unwrap();
    state.pending.lock().unwrap().as_mut().unwrap().deadline =
        Instant::now() - Duration::from_secs(1);
    assert!(state.before_restart(Some(&id)).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    state.cancel(&id).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancelled_or_replaced_reservations_never_terminate_children() {
    let (root, state, calls) = fixture();
    let id = state.prepare().unwrap();
    state.cancel(&id).unwrap();
    assert!(state.before_restart(Some(&id)).is_err());
    let other = state.prepare().unwrap();
    fs::rename(root.join(DIRECTORY), root.join("old-owner")).unwrap();
    fs::create_dir(root.join(DIRECTORY)).unwrap();
    fs::write(root.join(DIRECTORY).join("replacement"), "preserve").unwrap();
    assert!(state.before_restart(Some(&other)).is_err());
    state.cancel(&other).unwrap();
    assert!(root.join(DIRECTORY).join("replacement").exists());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_process_starting_after_an_earlier_idle_snapshot_refuses_cleanup() {
    let (root, state, calls) = fixture();
    fs::create_dir(root.join("work-launches")).unwrap();
    let id = Uuid::new_v4().to_string();
    fs::write(root.join("work-launches").join(format!("{id}.json")),
        serde_json::json!({"id": id, "label": "Late terminal", "ownerPid": std::process::id(), "pid": std::process::id()}).to_string()).unwrap();
    assert!(state.before_restart(None).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn final_inspection_is_under_reservation_and_refuses_before_cleanup() {
    let (root, state, calls) = fixture();
    let directory = root.clone();
    let state = state.with_work_inspection(move |id, _| {
        assert_eq!(read_operation(&directory.join(DIRECTORY)).unwrap().id, id);
        Err("Late managed run".into())
    });
    let id = state.prepare().unwrap();
    assert!(state.before_restart(Some(&id)).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    state.cancel(&id).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn forced_restart_records_an_installer_appearing_during_final_inspection() {
    let (root, state, calls) = fixture();
    let directory = root.clone();
    let state = state.with_work_inspection(move |_, force| {
        assert!(force);
        fs::write(
            directory.join("codex-cli-update.lock"),
            "installer started during inspection",
        )
        .unwrap();
        Ok(())
    });
    let id = state.prepare_with_work(true).unwrap();
    state.before_restart(Some(&id)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let receipt =
        fs::read_to_string(root.join("forced-restarts").join(format!("{id}.json"))).unwrap();
    assert!(receipt.contains("installer started during inspection"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn never_bound_work_expires_at_native_admission() {
    let (root, state, calls) = fixture();
    fs::create_dir(root.join("work-launches")).unwrap();
    let id = Uuid::new_v4().to_string();
    let file = root.join("work-launches").join(format!("{id}.json"));
    fs::write(
        &file,
        serde_json::json!({"id":id,"label":"Unbound worker",
        "ownerPid":std::process::id(),"pid":null,"createdAtMs":1,"createdMonotonicMs":1})
        .to_string(),
    )
    .unwrap();
    state.before_restart(None).unwrap();
    assert!(!file.exists());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn forced_restart_records_live_and_unbound_leases_before_cleanup() {
    let (root, state, calls) = fixture();
    fs::create_dir(root.join("work-launches")).unwrap();
    let id = Uuid::new_v4().to_string();
    fs::write(root.join("work-launches").join(format!("{id}.json")),
        serde_json::json!({"id":id,"label":"Live publication","ownerPid":std::process::id(),"pid":null}).to_string()).unwrap();
    fs::write(root.join("codex-cli-update.lock"), "Live installer").unwrap();
    let reservation = state.prepare_with_work(true).unwrap();
    state.before_restart(Some(&reservation)).unwrap();
    let receipt = fs::read_to_string(
        root.join("forced-restarts")
            .join(format!("{reservation}.json")),
    )
    .unwrap();
    assert!(receipt.contains("Live publication"));
    assert!(receipt.contains("codex-cli-update.lock"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn forced_restart_keeps_live_installer_identity_and_records_unavailable_inspection() {
    let (root, state, calls) = fixture();
    let installer = Uuid::new_v4().to_string();
    let directory = root.join(DIRECTORY);
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join(format!("{installer}.json")), serde_json::json!({
        "version":1,"id":installer,"kind":"installer","runtime":"fixture","pid":std::process::id(),
        "ownerPid":std::process::id(),"ownerIdentity":lease_owner::identity(std::process::id()).unwrap(),
        "createdAtMs":lease_owner::now_ms(),"startedAt":"fixture","stage":"installing"}).to_string()).unwrap();
    let state = state.with_work_inspection(|_, _| Err("Live work inventory unavailable".into()));
    let id = state.prepare_with_work(true).unwrap();
    assert_ne!(id, installer);
    state.before_restart(Some(&id)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(directory.join(format!("{installer}.json")).exists());
    let receipt =
        fs::read_to_string(root.join("forced-restarts").join(format!("{id}.json"))).unwrap();
    assert!(receipt.contains("Live work inventory unavailable"));
    assert!(receipt.contains(&installer));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn forced_request_gets_a_fresh_reservation_and_deadline() {
    let (root, state, calls) = fixture();
    let old = state.prepare().unwrap();
    state.pending.lock().unwrap().as_mut().unwrap().deadline =
        Instant::now() + Duration::from_millis(1);
    let id = state.prepare_with_work(true).unwrap();
    assert_ne!(id, old);
    assert!(state.cancel(&old).is_err());
    state.before_restart(Some(&id)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn force_records_and_displaces_a_malformed_writer_slot() {
    let (root, state, calls) = fixture();
    fs::write(root.join(DIRECTORY), "unknown writer").unwrap();
    let id = state.prepare_with_work(true).unwrap();
    state.before_restart(Some(&id)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn force_displaces_a_writer_symlink_without_recovering_its_target() {
    let (root, state, calls) = fixture();
    let target = root.join("target");
    fs::create_dir(&target).unwrap();
    let sentinel = target.join("owner.json");
    fs::write(&sentinel, "preserve").unwrap();
    std::os::unix::fs::symlink(&target, root.join(DIRECTORY)).unwrap();
    let id = state.prepare_with_work(true).unwrap();
    state.before_restart(Some(&id)).unwrap();
    assert_eq!(fs::read_to_string(sentinel).unwrap(), "preserve");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn force_retries_when_installer_settles_before_owner_publication() {
    let (root, state, calls) = fixture();
    let directory = root.join(DIRECTORY);
    fs::create_dir(&directory).unwrap();
    let installer = Uuid::new_v4().to_string();
    fs::write(directory.join(format!("{installer}.json")), serde_json::json!({
        "version":1,"id":installer,"kind":"installer","runtime":"fixture","pid":std::process::id(),
        "ownerPid":std::process::id(),"ownerIdentity":lease_owner::identity(std::process::id()).unwrap(),
        "createdAtMs":lease_owner::now_ms(),"startedAt":"fixture","stage":"installing"}).to_string()).unwrap();
    // Schedule the other owner's real unlink/rmdir at the publication boundary.
    SETTLE_WRITER.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |directory| {
            fs::remove_file(directory.join(format!("{installer}.json"))).unwrap();
            fs::remove_dir(directory).unwrap();
        }))
    });
    let id = state.prepare_with_work(true).unwrap();
    state.before_restart(Some(&id)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_unbound_age_is_monotonic_at_native_admission() {
    let (root, state, calls) = fixture();
    fs::create_dir(root.join("work-launches")).unwrap();
    let id = Uuid::new_v4().to_string();
    let file = root.join("work-launches").join(format!("{id}.json"));
    fs::write(
        &file,
        serde_json::json!({"id":id,"label":"Legacy unbound",
        "ownerPid":std::process::id(),"pid":null,"createdAtMs":1})
        .to_string(),
    )
    .unwrap();
    assert!(state.before_restart(None).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    lease_owner::expire_observation(&file);
    state.before_restart(None).unwrap();
    assert!(!file.exists());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unavailable_identity_refuses_normal_restart_but_force_records_before_cleanup() {
    let (root, state, calls) = fixture();
    let receipts = root.join("forced-restarts");
    let state = state.with_work_inspection(move |_, _| {
        assert!(fs::read_dir(&receipts)
            .unwrap()
            .flatten()
            .any(|entry| fs::read_to_string(entry.path())
                .unwrap()
                .contains("identity unavailable")));
        Ok(())
    });
    lease_owner::IDENTITY_UNAVAILABLE.with(|unavailable| unavailable.set(true));
    let normal = state.prepare();
    let forced = state.prepare_with_work(true);
    lease_owner::IDENTITY_UNAVAILABLE.with(|unavailable| unavailable.set(false));
    assert!(normal.unwrap_err().contains("identity unavailable"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let id =
        forced.expect("force must retain explicit interruption consent when identity is unknown");
    let operation = read_operation(&root.join(DIRECTORY)).unwrap();
    assert!(operation.owner_identity.is_null());
    state.before_restart(Some(&id)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}
