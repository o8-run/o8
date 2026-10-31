//! Drag-to-reorder within the Pinned shelf: order and key planning.
use super::thread_list::pins::{key_between, plan_keys, reorder};
use std::collections::HashMap;

fn valid(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|c| c.is_ascii_lowercase()) && !key.ends_with('a')
}
fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
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
        assert!(lo.is_none_or(|lo| lo < k.as_str()), "{lo:?} < {k}");
        assert!(hi.is_none_or(|hi| k.as_str() < hi), "{k} < {hi:?}");
    }
    // Repeated inserts at the front and back keep working.
    let (mut lo, mut hi) = (key_between(None, None), key_between(None, None));
    for _ in 0..60 {
        let front = key_between(None, Some(&lo));
        assert!(valid(&front) && front < lo);
        lo = front;
        let back = key_between(Some(&hi), None);
        assert!(valid(&back) && back > hi);
        hi = back;
    }
}

#[test]
fn pin_reorder_moves_before_or_after_the_target() {
    let order = ids(&["a", "b", "c"]);
    assert_eq!(reorder(&order, "c", "a", false), Some(ids(&["c", "a", "b"])));
    assert_eq!(reorder(&order, "a", "c", true), Some(ids(&["b", "c", "a"])));
    assert_eq!(reorder(&order, "a", "b", true), Some(ids(&["b", "a", "c"])));
    assert_eq!(reorder(&order, "a", "b", false), None, "no-op drop");
    assert_eq!(reorder(&order, "b", "b", true), None);
    assert_eq!(reorder(&order, "x", "a", false), None, "not pinned");
    assert_eq!(reorder(&order, "a", "x", false), None, "target not pinned");
}

#[test]
fn pin_reorder_plans_one_write_between_keyed_neighbours() {
    let keys: HashMap<String, Option<String>> = [("a", "b"), ("b", "n"), ("c", "t")]
        .into_iter()
        .map(|(id, k)| (id.to_string(), Some(k.to_string())))
        .collect();
    let next = reorder(&ids(&["a", "b", "c"]), "c", "a", true).unwrap();
    let writes = plan_keys(&next, &keys, "c");
    assert_eq!(writes.len(), 1);
    let (id, key) = &writes[0];
    assert_eq!(id, "c");
    assert!(valid(key) && "b" < key.as_str() && key.as_str() < "n");
}

#[test]
fn pin_reorder_rekeys_when_some_pins_have_no_server_order() {
    let keys: HashMap<String, Option<String>> = HashMap::from([
        ("a".into(), Some("n".into())), ("b".into(), None), ("c".into(), None),
    ]);
    let next = ids(&["c", "a", "b"]);
    let writes = plan_keys(&next, &keys, "c");
    let mut merged = keys.clone();
    for (id, k) in &writes {
        assert!(valid(k));
        merged.insert(id.clone(), Some(k.clone()));
    }
    let mut sorted = next.clone();
    sorted.sort_by_key(|id| merged[id].clone().unwrap());
    assert_eq!(sorted, next, "keys realise the dragged order");
    assert!(merged.values().all(Option::is_some), "no pin left unkeyed");
}
