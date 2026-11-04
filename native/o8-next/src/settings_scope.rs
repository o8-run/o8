//! Settings scope: which layer a row edits and which layer its value comes from.
//! The server owns the layers in settings.toml and resolves them per key:
//! This machine over This project over Global over the default.
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Scope {
    Default,
    Global,
    Project,
    Machine,
}
impl Scope {
    pub const EDITABLE: [Scope; 3] = [Scope::Global, Scope::Project, Scope::Machine];
    pub fn label(self) -> &'static str {
        match self {
            Scope::Default => "Default",
            Scope::Global => "Global",
            Scope::Project => "This project",
            Scope::Machine => "This machine",
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Scope::Default => "default",
            Scope::Global => "global",
            Scope::Project => "project",
            Scope::Machine => "machine",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct Layers {
    #[serde(default)]
    pub global: BTreeMap<String, Value>,
    #[serde(default)]
    pub project: BTreeMap<String, Value>,
    #[serde(default)]
    pub machine: BTreeMap<String, Value>,
}
/// Absent from an older server, which then shows no scope selector.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct ScopeInfo {
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub layers: Layers,
}
impl ScopeInfo {
    pub fn layer(&self, scope: Scope) -> Option<&BTreeMap<String, Value>> {
        match scope {
            Scope::Global => Some(&self.layers.global),
            Scope::Project => self.project_id.as_ref().map(|_| &self.layers.project),
            Scope::Machine => Some(&self.layers.machine),
            Scope::Default => None,
        }
    }
    /// The layer the value comes from, by the server's precedence.
    pub fn effective(&self, id: &str) -> Scope {
        [Scope::Machine, Scope::Project, Scope::Global]
            .into_iter()
            .find(|scope| self.layer(*scope).is_some_and(|l| l.contains_key(id)))
            .unwrap_or(Scope::Default)
    }
}

/// What one Settings row shows for its scope.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ScopeRow {
    /// The layer the row's controls edit.
    pub selected: Scope,
    /// The layer the resolved value comes from.
    pub effective: Scope,
    /// Scopes a person can choose; This project needs an open project.
    pub choices: Vec<Scope>,
    /// The value the controls show: the selected layer's, else the resolved one.
    pub value: Value,
    /// Whether the selected layer holds its own value that Clear removes.
    pub clearable: bool,
    /// Shown when a higher layer overrides the one being edited.
    pub indicator: Option<String>,
}

/// The row view model, or None when the server does not scope this key.
pub(crate) fn scope_row(
    info: Option<&ScopeInfo>,
    id: &str,
    resolved: &Value,
    selected: Option<Scope>,
) -> Option<ScopeRow> {
    let info = info.filter(|i| i.keys.iter().any(|k| k == id))?;
    let effective = info.effective(id);
    let choices: Vec<Scope> = Scope::EDITABLE
        .into_iter()
        .filter(|s| info.layer(*s).is_some())
        .collect();
    // Edit where the value comes from unless a person chose another layer.
    let selected =
        selected
            .filter(|s| choices.contains(s))
            .unwrap_or(if effective == Scope::Default {
                Scope::Global
            } else {
                effective
            });
    let own = info.layer(selected).and_then(|l| l.get(id)).cloned();
    let indicator = (effective > selected).then(|| {
        format!(
            "{} value is overridden by {}.",
            selected.label(),
            effective.label().to_lowercase()
        )
    });
    Some(ScopeRow {
        selected,
        effective,
        choices,
        value: own.clone().unwrap_or_else(|| resolved.clone()),
        clearable: own.is_some() && selected != Scope::Global,
        indicator,
    })
}

/// The read path: resolve against the open project when there is one.
pub(crate) fn read_path(base: &str, project: Option<&str>) -> String {
    match project {
        Some(project) => format!("{base}&project={}", encode(project)),
        None => base.to_owned(),
    }
}
/// The write path for a layer; Global keeps the existing route unchanged.
pub(crate) fn write_path(base: &str, scope: Scope, project: Option<&str>) -> String {
    match scope {
        Scope::Project => format!(
            "{base}&scope=project&project={}",
            encode(project.unwrap_or_default())
        ),
        Scope::Machine => format!("{base}&scope=machine"),
        Scope::Global | Scope::Default => base.to_owned(),
    }
}
fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info(global: Value, project: Value, machine: Value, project_id: Option<&str>) -> ScopeInfo {
        serde_json::from_value(json!({
            "projectId": project_id,
            "keys": ["parallelCap", "branchPrefix"],
            "layers": {"global": global, "project": project, "machine": machine},
        }))
        .unwrap()
    }

    #[test]
    fn effective_scope_follows_machine_over_project_over_global_over_default() {
        let cases = [
            (json!({}), json!({}), json!({}), Scope::Default),
            (
                json!({"parallelCap": 3}),
                json!({}),
                json!({}),
                Scope::Global,
            ),
            (
                json!({"parallelCap": 3}),
                json!({"parallelCap": 4}),
                json!({}),
                Scope::Project,
            ),
            (
                json!({}),
                json!({"parallelCap": 4}),
                json!({}),
                Scope::Project,
            ),
            (
                json!({"parallelCap": 3}),
                json!({"parallelCap": 4}),
                json!({"parallelCap": 5}),
                Scope::Machine,
            ),
            (
                json!({}),
                json!({}),
                json!({"parallelCap": 5}),
                Scope::Machine,
            ),
        ];
        for (global, project, machine, expected) in cases {
            assert_eq!(
                info(global, project, machine, Some("p1")).effective("parallelCap"),
                expected
            );
        }
        // Without an open project the project layer never applies.
        assert_eq!(
            info(
                json!({"parallelCap": 3}),
                json!({"parallelCap": 4}),
                json!({}),
                None
            )
            .effective("parallelCap"),
            Scope::Global
        );
    }

    #[test]
    fn row_shows_the_override_indicator_when_a_higher_layer_wins() {
        let info = info(
            json!({"parallelCap": 3}),
            json!({"parallelCap": 4}),
            json!({"parallelCap": 5}),
            Some("p1"),
        );
        let resolved = json!(5);
        let row = scope_row(Some(&info), "parallelCap", &resolved, None).unwrap();
        assert_eq!(
            (row.selected, row.effective),
            (Scope::Machine, Scope::Machine)
        );
        assert_eq!(row.indicator, None);
        assert!(row.clearable);

        let row = scope_row(Some(&info), "parallelCap", &resolved, Some(Scope::Global)).unwrap();
        assert_eq!(row.value, json!(3));
        assert!(!row.clearable);
        assert_eq!(
            row.indicator.as_deref(),
            Some("Global value is overridden by this machine.")
        );
        let row = scope_row(Some(&info), "parallelCap", &resolved, Some(Scope::Project)).unwrap();
        assert_eq!(row.value, json!(4));
        assert!(row.clearable);
        assert!(row.indicator.is_some());

        // An unset layer shows the value that falls through to it.
        let row = scope_row(
            Some(&info),
            "branchPrefix",
            &json!("o8/"),
            Some(Scope::Machine),
        )
        .unwrap();
        assert_eq!(
            (row.value, row.clearable, row.indicator),
            (json!("o8/"), false, None)
        );
        assert_eq!(row.effective, Scope::Default);
    }

    #[test]
    fn rows_without_a_project_or_server_scope_offer_less() {
        let none = info(json!({}), json!({}), json!({}), None);
        let row = scope_row(Some(&none), "parallelCap", &json!(4), Some(Scope::Project)).unwrap();
        assert_eq!(row.choices, vec![Scope::Global, Scope::Machine]);
        assert_eq!(row.selected, Scope::Global);
        assert!(scope_row(Some(&none), "knowledgeSources", &json!([]), None).is_none());
        assert!(scope_row(None, "parallelCap", &json!(4), None).is_none());
    }

    #[test]
    fn paths_carry_the_scope_and_an_encoded_project() {
        let base = "/api/panel/operator-defaults?include=native";
        assert_eq!(read_path(base, None), base);
        assert_eq!(
            read_path(base, Some("a b/c")),
            format!("{base}&project=a+b%2Fc")
        );
        assert_eq!(write_path(base, Scope::Global, Some("p")), base);
        assert_eq!(
            write_path(base, Scope::Machine, Some("p")),
            format!("{base}&scope=machine")
        );
        assert_eq!(
            write_path(base, Scope::Project, Some("p")),
            format!("{base}&scope=project&project=p")
        );
    }
}

#[cfg(test)]
#[path = "settings_scope_tests.rs"]
mod view_tests;
