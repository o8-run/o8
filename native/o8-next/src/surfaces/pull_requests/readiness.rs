//! Merge readiness for the PR list's "Merge readiness" sort (T3 36:38).
//! A pure score from fields the list page already carries: state, draft,
//! checks, reviewDecision and mergeable. Higher is closer to mergeable.
use serde_json::Value;

/// The score and the reasons behind it, most important first.
pub fn readiness(row: &Value) -> (i32, Vec<&'static str>) {
    let mut score = 0;
    let mut reasons = vec![];
    if row["state"] != "open" {
        return (-1000, vec!["Not open"]);
    }
    if row["draft"] == true {
        score -= 40;
        reasons.push("Draft");
    }
    match row["mergeable"].as_str() {
        Some("CONFLICTING") => {
            score -= 40;
            reasons.push("Conflicts");
        }
        Some("MERGEABLE") => score += 10,
        _ => {}
    }
    match row["checks"].as_str() {
        Some("success") => {
            score += 30;
            reasons.push("Checks pass");
        }
        Some("pending") => {
            score += 10;
            reasons.push("Checks running");
        }
        Some("failure") => {
            score -= 30;
            reasons.push("Checks failing");
        }
        _ => {}
    }
    match row["reviewDecision"].as_str() {
        Some("APPROVED") => {
            score += 30;
            reasons.push("Approved");
        }
        Some("CHANGES_REQUESTED") => {
            score -= 30;
            reasons.push("Changes requested");
        }
        Some("REVIEW_REQUIRED") => {
            score -= 5;
            reasons.push("Review required");
        }
        _ => {}
    }
    (score, reasons)
}

/// Stable: equal scores keep the server's (updated) order.
pub fn sort_by_readiness(rows: &mut [Value]) {
    rows.sort_by_key(|row| std::cmp::Reverse(readiness(row).0));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open() -> Value {
        json!({"state": "open", "draft": false, "checks": null, "reviewDecision": null, "mergeable": null})
    }
    fn with(key: &str, value: Value) -> Value {
        let mut row = open();
        row[key] = value;
        row
    }

    #[test]
    fn each_factor_moves_the_score() {
        let base = readiness(&open()).0;
        assert!(readiness(&with("draft", json!(true))).0 < base);
        assert!(readiness(&with("mergeable", json!("CONFLICTING"))).0 < base);
        assert!(readiness(&with("mergeable", json!("MERGEABLE"))).0 > base);
        assert!(readiness(&with("checks", json!("success"))).0 > base);
        assert!(readiness(&with("checks", json!("pending"))).0 > base);
        assert!(readiness(&with("checks", json!("failure"))).0 < base);
        assert!(readiness(&with("reviewDecision", json!("APPROVED"))).0 > base);
        assert!(readiness(&with("reviewDecision", json!("CHANGES_REQUESTED"))).0 < base);
        assert!(readiness(&with("state", json!("merged"))).0 < base - 100);
        assert_eq!(readiness(&with("checks", json!("failure"))).1, vec!["Checks failing"]);
    }

    #[test]
    fn sort_is_stable_and_readiest_first() {
        let mut ready = with("checks", json!("success"));
        ready["reviewDecision"] = json!("APPROVED");
        let mut rows = vec![
            json!({"number": 1, "state": "open", "draft": true}),
            json!({"number": 2, "state": "open"}),
            { let mut r = ready.clone(); r["number"] = json!(3); r },
            json!({"number": 4, "state": "open"}),
        ];
        sort_by_readiness(&mut rows);
        let order: Vec<_> = rows.iter().map(|r| r["number"].as_u64().unwrap()).collect();
        assert_eq!(order, vec![3, 2, 4, 1]);
    }
}
