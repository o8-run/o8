use super::*;

pub(super) fn current(reader: &NativeReads, db: &Connection) -> ReadResult<Value> {
    let file = reader.json("orchestrator-state.json")?;
    if file["version"] != 1 {
        return Err(());
    }
    let mission = file["mission"].clone();
    let packets = array(&mission["packets"])?;
    let lanes = lanes(db)?;
    // Runtime bindings, release reconciliation and dispatch admission retain
    // their existing owners. An unbound prepared mission is a passive read.
    for packet in packets {
        if !packet["lane"].is_null()
            || packet["status"] != "queued"
            || packet["workspaceTargetPath"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            || lanes.iter().any(|lane| lane["packetId"] == packet["id"])
            || packet["manualLaunchClaim"].is_object()
            || !packet["archivedAt"].is_null()
            || packet["operatorStopped"] == true
            || packet["queueState"] != "queued"
            || !packet["storageAdmission"].is_null()
            || !packet["holdIntent"].is_null()
            || !packet["hold"].is_null()
            || !array(&packet["dependencyPacketIds"])?.is_empty()
            || packet["preflightRefusals"].as_i64().is_some_and(|n| n > 0)
            || packet["releaseState"] != "pending"
            || !packet["blockedReason"].is_null()
        {
            return Err(());
        }
    }
    Ok(mission)
}
