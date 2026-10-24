use super::*;

fn live(pid: &Value, identity: &Value) -> ReadResult<()> {
    let pid = pid.as_u64().filter(|pid| *pid > 0).ok_or(())?;
    let identity: Value = serde_json::from_str(identity.as_str().ok_or(())?).map_err(|_| ())?;
    process_identity::matches(pid, &identity)
}

pub(super) fn status(db: &Connection, args: &Value) -> ReadResult<Value> {
    let resource = string(args, "resource")?.trim();
    if resource.is_empty()
        || resource.len() > 2048
        || !resource.bytes().all(|b| (0x20..=0x7e).contains(&b))
    {
        return Err(());
    }
    let list = read(db)?;
    let lease = array(&list["leases"])?
        .iter()
        .find(|lease| lease["resource"] == resource)
        .cloned()
        .unwrap_or_else(|| {
            json!({"schema":"o8/resource-lease/v1","resource":resource,
            "holder":null,"waiters":[],"blocked":null})
        });
    Ok(json!({"schema":"o8/resource-lease.status/v1","ok":true,"lease":lease}))
}
pub(super) fn read(db: &Connection) -> ReadResult<Value> {
    let holders = rows(db, "SELECT * FROM resource_leases ORDER BY resource ASC")?;
    let waiters = rows(
        db,
        "SELECT * FROM resource_lease_waiters ORDER BY queue_sequence ASC",
    )?;
    let mut leases = Vec::new();
    // A holderless queue needs promotion, which only the TypeScript writer may do.
    if waiters
        .iter()
        .any(|w| !holders.iter().any(|h| h["resource"] == w["resource"]))
    {
        return Err(());
    }
    for holder in holders {
        live(&holder["owner_pid"], &holder["owner_identity_json"])?;
        let resource = &holder["resource"];
        let mut public_waiters = Vec::new();
        for waiter in waiters.iter().filter(|w| w["resource"] == *resource) {
            live(&waiter["owner_pid"], &waiter["owner_identity_json"])?;
            live(&waiter["waiter_pid"], &waiter["waiter_identity_json"])?;
            if waiter["actor"].as_str().is_none_or(|s| s.trim().is_empty())
                || waiter["claim_token_hash"].as_str().is_none_or(|s| {
                    s.len() != 64
                        || !s
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            {
                return Err(());
            }
            public_waiters.push(json!({"waiterId":waiter["waiter_id"],"resource":resource,
                "owner":{"id":waiter["owner_id"],"label":waiter["owner_label"],"pid":waiter["owner_pid"]},"position":public_waiters.len()+1,
                "enqueuedAt":iso(waiter["enqueued_at"].as_i64().ok_or(())?)?,"lastSeenAt":iso(waiter["last_seen_at"].as_i64().ok_or(())?)?,"ttlMs":waiter["ttl_ms"]}));
        }
        let heartbeat = holder["heartbeat_at"].as_i64().ok_or(())?;
        let expires = heartbeat
            .checked_add(holder["ttl_ms"].as_i64().ok_or(())?)
            .ok_or(())?;
        leases.push(json!({"schema":"o8/resource-lease/v1","resource":resource,"holder":{
            "resource":resource,"leaseId":holder["lease_id"],"owner":{"id":holder["owner_id"],"label":holder["owner_label"],"pid":holder["owner_pid"]},
            "acquiredAt":iso(holder["acquired_at"].as_i64().ok_or(())?)?,"ttlMs":holder["ttl_ms"],"heartbeatAt":iso(heartbeat)?,"expiresAt":iso(expires)?,"overdue":expires<=Utc::now().timestamp_millis()},"waiters":public_waiters,"blocked":null}));
    }
    Ok(json!({"schema":"o8/resource-lease.list/v1","ok":true,"count":leases.len(),"leases":leases}))
}
