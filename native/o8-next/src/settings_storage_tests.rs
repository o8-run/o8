use super::*;
use crate::settings::test_peer::*;
use gpui::TestAppContext;

// Admission fields match readPacketStorageAdmissionProjection's returned shape.
fn projection_usage(physical: Option<u64>, headroom: Option<i64>) -> Value {
    let observed = physical.is_some();
    json!({
        "schema":"o8/worktree-storage-telemetry/v1",
        "measuredAt":"2026-11-01T06:00:00Z",
        "accountingStatus":if observed { "observed" } else { "partial" },
        "totalCount":2,"totalBytes":1024,"totalAllocatedBytes":1024,"totalLogicalBytes":2048,
        "storageAdmission":{
            "accountingStatus":if observed { "observed" } else { "unknown" },
            "reserveRatio":0.1,"absoluteFloorBytes":500,
            "physicalAvailableBytes":physical,
            "reservedBytes":if observed { 300 } else { 0 },
            "requiredReserveBytes":physical.map(|_| 500),
            "dispatchHeadroomBytes":headroom,
            "activeReservations":if observed { 1 } else { 0 }
        },
        "storagePressure":{"parkedWorkspaces":2,"eligibleRepositories":3,"optedOutRepositories":1,"repositories":[]},
        "categoryStorage":{"measuredAt":"2026-11-01T06:00:00Z","categories":{}}
    })
}

#[gpui::test]
fn settings_correction_5220_signed_headroom_from_producer_shape(cx: &mut TestAppContext) {
    let peer = Peer::new();
    peer.reply(
        "GET",
        "/api/worktrees/retention-usage",
        200,
        projection_usage(Some(100), Some(-700)),
    );
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    click(cx, "settings-nav-storage");
    wait(&view, cx, |s| !s.storage.busy && s.storage.usage.is_some());
    assert!(
        cx.debug_bounds("settings-storage-headroom-value--700 B")
            .is_some(),
        "reserve pressure must remain negative in the rendered metric"
    );
    for (status, physical, headroom, selector) in [
        (
            200,
            Some(1000),
            Some(200),
            "settings-storage-headroom-value-200 B",
        ),
        (503, None, None, "settings-storage-headroom-value-Unknown"),
    ] {
        peer.reply(
            "GET",
            "/api/worktrees/retention-usage",
            status,
            projection_usage(physical, headroom),
        );
        click(cx, "setting-storage-refresh");
        wait(&view, cx, |s| !s.storage.busy);
        assert!(
            cx.debug_bounds(selector).is_some(),
            "missing rendered producer value: {selector}"
        );
        assert_eq!(
            view.read_with(cx, |s, _| s.storage.error.is_some()),
            status == 503
        );
    }
    assert!(
        cx.debug_bounds("settings-storage-allocated-value-1.0 KiB")
            .is_some()
    );
    assert!(
        cx.debug_bounds("settings-storage-logical-value-2.0 KiB")
            .is_some()
    );
    assert!(view.read_with(cx, |s, _| {
        s.storage.usage.as_ref().is_some_and(|usage| {
            usage.total_allocated_bytes == Some(1024) && usage.total_logical_bytes == Some(2048)
        })
    }));
    assert!(peer.calls().iter().all(|(method, _, _)| method == "GET"));
}

#[gpui::test]
fn settings_parity_storage_refresh_keeps_unknown_accounting(cx: &mut TestAppContext) {
    let peer = Peer::new();
    peer.reply("GET", "/api/worktrees/retention-usage", 200, json!({"accountingStatus":"observed","totalAllocatedBytes":1024,"totalLogicalBytes":2048,"storageAdmission":{"physicalAvailableBytes":1000,"reservedBytes":300,"dispatchHeadroomBytes":700},"storagePressure":{"parkedWorkspaces":2,"eligibleRepositories":3,"optedOutRepositories":1,"repositories":[]},"categoryStorage":{"measuredAt":"2026-10-31T12:00:00Z","categories":{"source":{"allocatedBytes":1024,"logicalBytes":2048,"measurementMethod":"workspace-residual"},"transcript":{"allocatedBytes":null,"logicalBytes":null,"measurementMethod":"owned-session-artifact-sum"}}}}));
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    click(cx, "settings-nav-storage");
    wait(&view, cx, |s| !s.storage.busy && s.storage.usage.is_some());
    assert!(cx.debug_bounds("settings-storage-headroom").is_some());
    assert_eq!(
        view.read_with(cx, |s, _| s
            .storage
            .usage
            .as_ref()
            .unwrap()
            .storage_admission
            .as_ref()
            .unwrap()
            .dispatch_headroom_bytes),
        Some(700)
    );
    peer.reply("GET", "/api/worktrees/retention-usage", 200, json!({"accountingStatus":"observed","totalAllocatedBytes":1024,"storageAdmission":{"physicalAvailableBytes":100,"reservedBytes":300,"dispatchHeadroomBytes":-700}}));
    click(cx, "setting-storage-refresh");
    wait(&view, cx, |s| !s.storage.busy);
    assert!(
        view.read_with(cx, |s, _| s.storage.error.is_none()),
        "negative task headroom must not discard known measurements"
    );
    assert_eq!(
        view.read_with(cx, |s, _| s
            .storage
            .usage
            .as_ref()
            .unwrap()
            .storage_admission
            .as_ref()
            .unwrap()
            .dispatch_headroom_bytes
            .map(|n| n.to_string())),
        Some("-700".into())
    );
    peer.reply(
        "GET",
        "/api/worktrees/retention-usage",
        503,
        json!({"accountingStatus":"observed","totalAllocatedBytes":13}),
    );
    click(cx, "setting-storage-refresh");
    wait(&view, cx, |s| !s.storage.busy);
    assert!(
        view.read_with(cx, |s, _| s.storage.error.is_some()
            && s.storage.usage.as_ref().unwrap().total_allocated_bytes == Some(13)),
        "HTTP failure remains degraded even with an observed tag"
    );
    peer.reply("GET", "/api/worktrees/retention-usage", 503, json!({"accountingStatus":"partial","totalAllocatedBytes":null,"totalLogicalBytes":null,"storageAdmission":{"physicalAvailableBytes":null,"reservedBytes":null,"dispatchHeadroomBytes":null}}));
    click(cx, "setting-storage-refresh");
    wait(&view, cx, |s| !s.storage.busy);
    assert!(view.read_with(cx, |s, _| {
        s.storage.error.is_some()
            && s.storage
                .usage
                .as_ref()
                .unwrap()
                .total_allocated_bytes
                .is_none()
    }));
    assert!(cx.debug_bounds("settings-storage-error").is_some());
    peer.reply("GET", "/api/worktrees/retention-usage", 503, json!({}));
    click(cx, "setting-storage-refresh");
    wait(&view, cx, |s| !s.storage.busy);
    assert!(view.read_with(cx, |s, _| s.storage.error.is_some()
        && s.storage.usage.is_none()));
    peer.reply(
        "GET",
        "/api/worktrees/retention-usage",
        200,
        json!({"accountingStatus":"observed","totalAllocatedBytes":0,"totalLogicalBytes":0}),
    );
    click(cx, "setting-storage-refresh");
    wait(&view, cx, |s| !s.storage.busy);
    assert!(view.read_with(cx, |s, _| s.storage.error.is_none()
        && s.storage.usage.as_ref().unwrap().total_allocated_bytes == Some(0)));
    assert!(peer.calls().iter().all(|(method, _, _)| method == "GET"));
}
