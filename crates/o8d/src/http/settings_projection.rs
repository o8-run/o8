//! Ordered declared TOML projection. Matches smol-toml table/array-table layout.
use super::{literal, Map, Value, Table, Toml};
#[derive(Default)]
struct Document(Vec<(String, Entry)>);
enum Entry { Table(Document), Tables(Vec<Document>), Leaf(Value) }
impl Document {
    fn insert(&mut self, path: &[Value], value: &Value) -> Result<(), ()> {
        let name = path.first().and_then(Value::as_str).ok_or(())?;
        if path.len() == 1 {
            self.0.push((name.to_owned(), entry(value)?));
            return Ok(());
        }
        let index = if let Some(i) = self.0.iter().position(|(k, _)| k == name) { i } else {
            self.0.push((name.to_owned(), Entry::Table(Document::default()))); self.0.len() - 1
        };
        match &mut self.0[index].1 { Entry::Table(doc) => doc.insert(&path[1..], value), _ => Err(()) }
    }
}
fn record(value: &Value) -> Result<Document, ()> {
    let fields: &[&str] = if value.get("runtime").is_some() { &["runtime", "model", "effort"] }
        else { &["id", "name", "path", "include", "exclude"] };
    let mut doc = Document::default();
    for key in fields { doc.0.push(((*key).into(), entry(value.get(*key).ok_or(())?)?)); }
    Ok(doc)
}
fn entry(value: &Value) -> Result<Entry, ()> {
    if value.is_object() { return Ok(Entry::Table(record(value)?)); }
    if let Some(items) = value.as_array().filter(|items| !items.is_empty() && items.iter().all(Value::is_object)) {
        return Ok(Entry::Tables(items.iter().map(record).collect::<Result<_, _>>()?));
    }
    Ok(Entry::Leaf(value.clone()))
}
fn render(doc: &Document, header: Option<&str>, prefix: &str) -> Result<String, ()> {
    let mut scalar = String::new();
    let mut children = Vec::new();
    for (name, value) in &doc.0 {
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}.{name}") };
        match value {
            Entry::Leaf(v) => scalar.push_str(&format!("{name} = {}\n", literal(v)?)),
            Entry::Table(child) => children.push(render(child, Some(&path), &path)?),
            Entry::Tables(items) => children.push(items.iter().map(|item| {
                Ok(format!("[[{path}]]\n{}", render(item, None, &path)?))
            }).collect::<Result<Vec<_>, ()>>()?.join("\n")),
        }
    }
    let children = children.join("\n");
    if let Some(header) = header {
        if !scalar.is_empty() { scalar = format!("[{header}]\n{scalar}"); }
        else if children.is_empty() { scalar = format!("[{header}]"); }
    }
    Ok(if !scalar.is_empty() && !children.is_empty() { format!("{scalar}\n{children}") } else { scalar + &children })
}
pub(super) fn text(values: &Map<String, Value>, fields: &[Value]) -> Result<String, ()> {
    let mut doc = Document::default();
    for field in fields {
        if let Some(value) = values.get(field["key"].as_str().ok_or(())?) {
            doc.insert(field["path"].as_array().ok_or(())?, value)?;
        }
    }
    let mut text = render(&doc, None, "")?;
    if !text.ends_with('\n') { text.push('\n'); }
    Ok(text)
}
fn has_additional(stored: &Table, projected: &Table) -> bool {
    stored.iter().any(|(key, value)| match projected.get(key) {
        None => true,
        Some(projected) => match value.as_table() {
            Some(table) => projected.as_table().is_none_or(|p| has_additional(table, p)),
            None => false,
        },
    })
}
pub(super) fn additional(stored: &Table, text: &str) -> Result<bool, ()> {
    Ok(has_additional(stored, &text.parse::<Table>().map_err(|_| ())?))
}
