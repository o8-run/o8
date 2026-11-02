//! Drag-to-reorder within the Pinned shelf: order and the single key write.
use super::thread_list::pins::{effective_key, implicit_key, key_between, pinned_order, plan_key, reorder};
use super::*;
use std::collections::HashMap;

fn valid(key: &str) -> bool {
    !key.is_empty() && key.len() <= 256 && key.bytes().all(|c| c.is_ascii_lowercase()) && !key.ends_with('a')
}
fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}
fn pin(id: &str, at: &str, key: Option<&str>) -> Session {
    serde_json::from_value(serde_json::json!({"id": id, "title": id, "status": "active",
        "pinnedAt": at, "pinOrderKey": key})).unwrap()
}
/// Applies one drop the way the sidebar does and returns (writes, new order).
fn drop(sessions: &mut [Session], moved: &str, target: &str, after: bool) -> (usize, Vec<String>) {
    let order = pinned_order(sessions);
    let Some(next) = reorder(&order, moved, target, after) else { return (0, order) };
    let keys: HashMap<String, String> = sessions
        .iter()
        .map(|s| (s.id.clone(), effective_key(s.pin_order_key.as_deref(), s.pinned_at.as_deref())))
        .collect();
    let (id, key) = plan_key(&next, &keys, moved).expect("a key fits");
    assert_eq!(id, moved);
    assert!(valid(&key), "{key}");
    sessions.iter_mut().find(|s| s.id == id).unwrap().pin_order_key = Some(key);
    let after_order = pinned_order(sessions);
    assert_eq!(after_order, next, "one key realises the dragged order");
    (1, after_order)
}

#[test]
fn pin_reorder_key_between_stays_valid_and_ordered() {
    let cases: &[(Option<&str>, Option<&str>)] = &[
        (None, None), (Some("n"), None), (None, Some("n")), (Some("b"), Some("c")),
        (Some("az"), Some("b")), (Some("y"), Some("z")), (Some("zz"), None), (None, Some("b")),
        (Some("b"), Some("bab")), (Some("n"), Some("nb")),
    ];
    for &(lo, hi) in cases {
        let k = key_between(lo, hi);
        assert!(valid(&k), "{lo:?}..{hi:?} gave {k}");
        assert!(lo.is_none_or(|lo| lo < k.as_str()) && hi.is_none_or(|hi| k.as_str() < hi));
    }
}

#[test]
fn pin_reorder_implicit_keys_keep_unkeyed_pins_last_by_pin_time() {
    let early = implicit_key("2026-10-31T01:00:00.000Z");
    let late = implicit_key("2026-10-31T02:00:00Z");
    assert!(valid(&early) && valid(&late) && early < late);
    assert!("zy" < early.as_str(), "after ordinary keys");
    let sessions = [pin("late", "2026-10-31T02:00:00Z", None), pin("k", "2026-10-31T03:00:00Z", Some("n")),
        pin("early", "2026-10-31T01:00:00Z", None)];
    assert_eq!(pinned_order(&sessions), ids(&["k", "early", "late"]));
}

#[test]
fn pin_reorder_moves_before_or_after_the_target() {
    let order = ids(&["a", "b", "c"]);
    assert_eq!(reorder(&order, "c", "a", false), Some(ids(&["c", "a", "b"])));
    assert_eq!(reorder(&order, "a", "c", true), Some(ids(&["b", "c", "a"])));
    assert_eq!(reorder(&order, "a", "b", false), None, "no-op drop");
    assert_eq!(reorder(&order, "x", "a", false), None, "not pinned");
}

#[test]
fn pin_reorder_every_drop_writes_exactly_one_thread() {
    // All unkeyed, as freshly pinned threads are.
    let mut s = vec![pin("a", "2026-10-31T01:00:00.000Z", None), pin("b", "2026-10-31T02:00:00.000Z", None),
        pin("c", "2026-10-31T03:00:00.000Z", None), pin("d", "2026-10-31T04:00:00.000Z", None)];
    assert_eq!(drop(&mut s, "d", "a", false), (1, ids(&["d", "a", "b", "c"])), "to first");
    assert_eq!(drop(&mut s, "a", "c", true), (1, ids(&["d", "b", "c", "a"])), "to last, among unkeyed");
    assert_eq!(drop(&mut s, "b", "c", true), (1, ids(&["d", "c", "b", "a"])), "between two unkeyed");
    assert_eq!(drop(&mut s, "d", "b", false), (1, ids(&["c", "d", "b", "a"])), "between keyed and unkeyed");
    for _ in 0..30 {
        let order = pinned_order(&s);
        let (first, last) = (order[0].clone(), order[3].clone());
        assert_eq!(drop(&mut s, &last, &first, false).0, 1);
        let order = pinned_order(&s);
        assert_eq!(drop(&mut s, &order[1].clone(), &order[2].clone(), true).0, 1);
    }
    assert!(s.iter().all(|x| x.pin_order_key.as_deref().is_none_or(valid)));
}

#[test]
fn pin_reorder_tied_neighbours_refuse_instead_of_rewriting() {
    let keys: HashMap<String, String> = [("a", "n"), ("b", "n"), ("c", "t")].map(|(i, k)| (i.into(), k.into())).into();
    assert_eq!(plan_key(&ids(&["a", "c", "b"]), &keys, "c"), None);
}
