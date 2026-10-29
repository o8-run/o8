//! Saved transcript references, placed without changing the underlying history.
use super::protocol::{Reference, references};
use crate::{
    model::{Entry, Row},
    text::Node,
};
use std::collections::HashMap;

pub type Anchors = HashMap<String, String>;

/// Pure placement: return updated conversation-local anchors alongside buckets.
pub fn place(
    refs: &[Reference],
    messages: &[Entry],
    previous: &Anchors,
) -> (HashMap<String, Vec<Reference>>, Anchors) {
    let mut anchors = previous.clone();
    let mut embedded = HashMap::new();
    for message in messages {
        for reference in references(message.tools.as_ref()) {
            let root = reference.state_id().to_owned();
            embedded.entry(root.clone()).or_insert_with(|| {
                anchors.insert(root, message.id.clone());
                (message.id.clone(), reference)
            });
        }
    }
    let mut buckets: HashMap<String, Vec<Reference>> = HashMap::new();
    for reference in refs {
        let root = reference.state_id();
        let target = if let Some((id, embedded)) = embedded.get(root) {
            if reference.version.unwrap_or(1) <= embedded.version.unwrap_or(1) {
                continue;
            }
            Some(id.clone())
        } else if let Some(id) = anchors.get(root) {
            // A partial page must wait for the producing message to load.
            messages.iter().any(|m| &m.id == id).then(|| id.clone())
        } else {
            let time = created_at_ms(&reference.created_at);
            let mut index = None;
            let mut nearest = f64::NEG_INFINITY;
            for (i, message) in messages.iter().enumerate() {
                if let Some(stamp) = timestamp(message)
                    && time.is_some_and(|time| stamp <= time)
                    && stamp >= nearest
                {
                    nearest = stamp;
                    index = Some(i);
                }
            }
            if index.is_none() && !messages.iter().any(|m| timestamp(m).is_some()) {
                index = messages.len().checked_sub(1);
            }
            if index.is_none_or(|i| messages[i].role != "assistant") {
                for (i, message) in messages.iter().enumerate().skip(index.map_or(0, |i| i + 1)) {
                    if message.role == "user" {
                        break;
                    }
                    if message.role == "assistant" {
                        index = Some(i);
                        break;
                    }
                }
            }
            index.map(|i| {
                let id = messages[i].id.clone();
                anchors.insert(root.to_owned(), id.clone());
                id
            })
        };
        if let Some(id) = target {
            buckets.entry(id).or_default().push(reference.clone());
        }
    }
    (buckets, anchors)
}

fn timestamp(message: &Entry) -> Option<f64> {
    let value = message.extra.get("timestamp")?;
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| v.is_finite())
}
fn created_at_ms(value: &str) -> Option<f64> {
    let seconds = crate::clock::timestamp(value)? as f64;
    // The clock helper returns whole seconds; placement needs the saved ms too.
    let fraction = value
        .get(19..)?
        .strip_prefix('.')
        .map(|suffix| {
            let digits: String = suffix
                .chars()
                .take_while(char::is_ascii_digit)
                .take(3)
                .collect();
            digits.parse::<u64>().unwrap_or(0) as f64 * 10_f64.powi(3 - digits.len() as i32)
        })
        .unwrap_or(0.);
    Some(seconds * 1000. + fraction)
}

/// Merge listed and embedded revisions by root, retaining the highest version.
pub fn merge(embedded: Vec<Reference>, listed: &[Reference]) -> Vec<Reference> {
    let mut merged: Vec<Reference> = vec![];
    for reference in embedded.into_iter().chain(listed.iter().cloned()) {
        if let Some(prior) = merged
            .iter_mut()
            .find(|r| r.state_id() == reference.state_id())
        {
            if prior.version.unwrap_or(1) <= reference.version.unwrap_or(1) {
                *prior = reference;
            }
        } else {
            merged.push(reference);
        }
    }
    merged
}

pub fn attach(rows: &mut [Row], buckets: &HashMap<String, Vec<Reference>>) {
    for row in rows {
        if let Row::Message { id, nodes, .. } = row {
            let embedded = nodes
                .iter()
                .filter(|n| n.kind == "visualization")
                .filter_map(|n| Reference::parse(n.data.as_ref()?))
                .collect();
            let refs = merge(
                embedded,
                buckets.get(id).map(Vec::as_slice).unwrap_or_default(),
            );
            nodes.retain(|n| n.kind != "visualization");
            nodes.extend(refs.into_iter().map(|reference| Node {
                kind: "visualization".into(),
                runs: vec![],
                language: None,
                data: serde_json::to_value(reference).ok(),
            }));
        }
    }
}

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;
