//! Saved roster candidate projection; no presence refresh, discovery acknowledgement or writer.
use super::settings_defaults::{js_trim, json_file};
use super::ReadContext;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
fn prefix(s: &str, max: usize) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}
fn text(v: &Value, max: usize) -> Option<String> {
    v.as_str()
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(|s| prefix(s, max))
}
struct Member {
    id: String,
    name: String,
    house: String,
    sources: Vec<String>,
}
pub(super) fn read(store: &ReadContext<'_>) -> Result<Value, ()> {
    let context = store.defaults_context.as_ref().ok_or(())?;
    let root = std::path::PathBuf::from(context["grokAgentRoot"].as_str().ok_or(())?);
    // Provider discovery needs locale-aware sorting and external profile admission.
    // Empty/missing provider root is proven here; populated roots retain their owner.
    match std::fs::read_dir(&root) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Err(());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(()),
    }
    let db = store.database()?;
    // TS ensures all three membership tables on read. An incomplete schema defers.
    let count:i64=db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('bot_members','bot_member_sources','bot_member_bindings')",[],|r|r.get(0)).map_err(|_|())?;
    if count != 3 {
        return Err(());
    }
    db.prepare("SELECT binding.id,binding.member_id,binding.agent_id,binding.agent_name,binding.repo_path,binding.runtime,binding.session_key,binding.created_at FROM bot_member_bindings binding LIMIT 0").map_err(|_|())?;
    let presence:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_presence')",[],|r|r.get(0)).map_err(|_|())?;
    if presence {
        db.prepare("SELECT binding.id,presence.last_seen FROM bot_member_bindings binding LEFT JOIN agent_presence presence ON presence.agent_id=binding.agent_id AND presence.repo_path=binding.repo_path AND presence.name=binding.agent_name COLLATE NOCASE AND presence.runtime=binding.runtime AND presence.session_key=binding.session_key LIMIT 0").map_err(|_|())?;
    }
    let mut statement = db
        .prepare("SELECT id,display_name,house FROM bot_members ORDER BY sequence")
        .map_err(|_| ())?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| ())?;
    let mut members = vec![];
    for row in rows {
        let (id, name, house) = row.map_err(|_| ())?;
        let mut q = db
            .prepare(
                "SELECT source_id FROM bot_member_sources WHERE member_id=? ORDER BY source_id",
            )
            .map_err(|_| ())?;
        let sources = q
            .query_map([&id], |r| r.get::<_, String>(0))
            .map_err(|_| ())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| ())?;
        members.push(Member {
            id,
            name,
            house,
            sources,
        });
    }
    let mut by_source = HashMap::new();
    for (i, m) in members.iter().enumerate() {
        by_source.insert(m.id.clone(), i);
        for source in &m.sources {
            by_source.insert(source.clone(), i);
        }
    }
    let raw = json_file(store, &store.directory.join("bots.json"))?;
    let mut entries = vec![];
    let mut source_seen = HashSet::new();
    if let Some(bots) = raw
        .as_ref()
        .and_then(|v| v.get("bots"))
        .and_then(Value::as_array)
    {
        for b in bots {
            let (Some(id), Some(house)) = (text(&b["id"], 160), text(&b["house"], 40)) else {
                continue;
            };
            if !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
            {
                continue;
            }
            if !house.is_ascii() {
                return Err(());
            }
            if source_seen.insert(id.clone()) {
                let name = text(&b["name"], 80).unwrap_or_else(|| id.clone());
                entries.push((id, name, house.to_ascii_lowercase()));
            }
        }
    }
    let mut seen = HashSet::new();
    let mut out = vec![];
    let candidate = |id: String, name: String, house: String| {
        let mut selections = vec![id.clone()];
        if let Some(i) = by_source.get(&id) {
            for source in &members[*i].sources {
                if !selections.contains(source) {
                    selections.push(source.clone());
                }
            }
        }
        json!({"id":id,"name":name,"house":house,"selectionIds":selections})
    };
    for (id, name, house) in entries {
        let (id, name) = if let Some(i) = by_source.get(&id) {
            let m = &members[*i];
            (m.id.clone(), m.name.clone())
        } else {
            (id, name)
        };
        if seen.insert(id.clone()) {
            out.push(candidate(id, name, house));
        }
    }
    for m in &members {
        if seen.insert(m.id.clone()) {
            out.push(candidate(m.id.clone(), m.name.clone(), m.house.clone()));
        }
    }
    Ok(Value::Array(out))
}
