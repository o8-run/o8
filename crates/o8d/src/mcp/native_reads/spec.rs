use super::*;

// The API's missing-file template is also a read: never create o8.md here.
const DEFAULT_TEMPLATE: &str = "# o8 Spec\n\n> One-page spec for this repo. Operator edits here. Agents read this on\n> dispatch and can write back when they need to record a decision.\n\n## Mission\n\nWhat this repo exists to do, in one paragraph.\n\n## Active scope\n\n- [ ] Goal you're working on right now\n- [ ] Next thing after that\n\n## Constraints\n\n- Hard rules the orchestrator must respect.\n\n## Open questions\n\n- Things you want surfaced for the operator before action.\n";

pub(super) fn read(args: &Value) -> ReadResult<Value> {
    let repo = PathBuf::from(string(args, "repoPath")?.trim());
    // Unusual path spellings retain the TypeScript path-normalization contract.
    if !repo.is_absolute()
        || fs::canonicalize(&repo).map_err(|_| ())?.as_os_str() != repo.as_os_str()
        || !repo.is_dir()
    {
        return Err(());
    }
    let path = repo.join("o8.md");
    let (content, exists) = match fs::read_to_string(&path) {
        Ok(content) => (content, true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (DEFAULT_TEMPLATE.to_owned(), false)
        }
        Err(_) => return Err(()),
    };
    let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
    Ok(json!({"ok":true,"content":content,"contentHash":hash,"exists":exists,"path":path}))
}
