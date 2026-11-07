//! Saved first-run progress, read and written by the desktop's rules
//! (onboarding-progress.ts): a known step name, a complete project or none,
//! and a first task that is neither of the built-in prompts and at most
//! 12,000 characters. The desktop's `ready` reads as `open`.
use super::{Project, Step};
use crate::shell_state::OnboardingProgress;
use serde_json::json;

/// The desktop's step names, in order.
const STEPS: [&str; 6] = [
    "open",
    "repos",
    "dispatch",
    "privacy",
    "permissions",
    "mobile",
];
const EXPLAIN_PROJECT: &str = "Explain this project: what it does, how it is organized, how to run it, and where I should start. Read the project instructions first. Do not change files.";
const PLAN_CHANGE: &str = "Help me plan a change to this project. Read the project instructions and structure, then ask me what I want to build before making changes.";

/// The desktop step a native page belongs to.
pub(super) fn step_name(step: Step) -> &'static str {
    match step {
        Step::Import | Step::Projects | Step::Folder | Step::NewProject => "open",
        Step::Repos => "repos",
        Step::Tools => "dispatch",
        Step::Privacy => "privacy",
        Step::Permissions => "permissions",
    }
}
/// The page a saved step reopens. A step this window has no page for yet
/// (mobile) reopens the last one it has.
fn page(name: &str) -> Step {
    match name {
        "repos" => Step::Repos,
        "dispatch" => Step::Tools,
        "permissions" => Step::Permissions,
        "privacy" | "mobile" => Step::Privacy,
        _ => Step::Projects,
    }
}
fn project(value: &serde_json::Value) -> Option<Project> {
    let text = |key: &str| value[key].as_str().map(str::to_owned);
    let (id, name, local_path) = (text("id")?, text("name")?, text("localPath")?);
    (!id.is_empty() && !local_path.is_empty()).then_some(Project {
        id,
        name,
        local_path,
    })
}

/// Where a relaunch resumes: the page, the project and whether tools were set.
pub(super) struct Resume {
    pub step: Step,
    pub project: Option<Project>,
    pub tools_configured: bool,
    pub task: String,
}
pub(super) fn read(saved: Option<&OnboardingProgress>) -> Resume {
    let fresh = Resume {
        step: Step::Projects,
        project: None,
        tools_configured: false,
        task: String::new(),
    };
    let Some(saved) = saved else { return fresh };
    let name = if saved.step == "ready" {
        "open"
    } else {
        saved.step.as_str()
    };
    if !STEPS.contains(&name) {
        return fresh;
    }
    let task = if saved.task == EXPLAIN_PROJECT || saved.task == PLAN_CHANGE {
        String::new()
    } else {
        saved.task.chars().take(12_000).collect()
    };
    Resume {
        step: page(name),
        project: saved.project.as_ref().and_then(project),
        tools_configured: saved.tools_configured,
        task,
    }
}
pub(super) fn write(
    step: Step,
    project: Option<&Project>,
    tools_configured: bool,
    task: &str,
) -> OnboardingProgress {
    OnboardingProgress {
        step: step_name(step).into(),
        project: project.map(|p| json!({"id": p.id, "name": p.name, "localPath": p.local_path})),
        tools_configured,
        task: task.into(),
    }
}

#[cfg(test)]
#[test]
fn saved_progress_reads_by_the_desktop_rules() {
    let saved = |step: &str, project: serde_json::Value, task: &str| OnboardingProgress {
        step: step.into(),
        project: Some(project),
        tools_configured: true,
        task: task.into(),
    };
    let good = json!({"id": "repo-1", "name": "Site", "localPath": "/work/site"});
    let resume = read(Some(&saved("dispatch", good.clone(), "Fix the header")));
    assert!(resume.step == Step::Tools && resume.tools_configured);
    assert_eq!(
        resume.project.as_ref().map(|p| p.name.as_str()),
        Some("Site")
    );
    assert_eq!(resume.task, "Fix the header");
    // `ready` reads as `open`; an unknown step starts over.
    assert!(read(Some(&saved("ready", good.clone(), ""))).step == Step::Projects);
    let unknown = read(Some(&saved("celebrate", good.clone(), "x")));
    assert!(
        unknown.step == Step::Projects && unknown.project.is_none() && !unknown.tools_configured
    );
    // The project and voice steps resume where they stopped; mobile has no page here yet.
    assert!(read(Some(&saved("repos", good.clone(), ""))).step == Step::Repos);
    assert_eq!(write(Step::Repos, None, false, "").step, "repos");
    assert!(read(Some(&saved("permissions", good.clone(), ""))).step == Step::Permissions);
    assert!(read(Some(&saved("mobile", good.clone(), ""))).step == Step::Privacy);
    // An incomplete project is dropped; built-in prompts and long tasks are not kept as typed.
    assert!(
        read(Some(&saved(
            "dispatch",
            json!({"id": "", "name": "x", "localPath": "/x"}),
            ""
        )))
        .project
        .is_none()
    );
    assert!(
        read(Some(&saved("open", good.clone(), EXPLAIN_PROJECT)))
            .task
            .is_empty()
    );
    assert_eq!(
        read(Some(&saved("open", good, &"y".repeat(13_000))))
            .task
            .chars()
            .count(),
        12_000
    );
    // A saved page writes back under the desktop's names.
    let project = Project {
        id: "repo-1".into(),
        name: "Site".into(),
        local_path: "/work/site".into(),
    };
    let written = write(Step::NewProject, Some(&project), false, "");
    assert_eq!(written.step, "open");
    assert_eq!(
        written.project,
        Some(json!({"id": "repo-1", "name": "Site", "localPath": "/work/site"}))
    );
}
