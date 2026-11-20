//! Plain o8.md reads. Node retains live principal, lane scope and target validation.
use super::*;
use sha2::{Digest, Sha256};
const DEFAULT_TEMPLATE: &str = r#"# o8 Spec

> One-page spec for this repo. Operator edits here. Agents read this on
> dispatch and can write back when they need to record a decision.

## Mission

What this repo exists to do, in one paragraph.

## Active scope

- [ ] Goal you're working on right now
- [ ] Next thing after that

## Constraints

- Hard rules the orchestrator must respect.

## Open questions

- Things you want surfaced for the operator before action.
"#;

pub(super) fn read(store: &ReadContext<'_>, params: &Params) -> Response {
    let result = (|| -> Result<Response, ()> {
        // RFM index and validation remain with their canonical parser.
        if matches!(value(params, "view"), "index" | "validate") {
            return Err(());
        }
        let policy = store.redaction.as_ref().ok_or(())?;
        let target = &store.defaults_context.as_ref().ok_or(())?["repoSpecTarget"];
        let root = target["root"].as_str().ok_or(())?;
        let relative = target["relativePath"].as_str().ok_or(())?;
        let path = target["path"].as_str().ok_or(())?;
        if relative != "o8.md" || !Path::new(root).is_absolute() || !Path::new(root).is_dir() {
            return Err(());
        }
        let respond = |status, body| {
            file_asset_viewer::json_ordered(
                policy,
                status,
                body,
                &[
                    "ok",
                    "content",
                    "contentHash",
                    "exists",
                    "path",
                    "error",
                    "code",
                    "redaction",
                ],
            )
        };
        let (content, exists) =
            match file_content::open_bytes(root, relative, None, 4 * 1024 * 1024) {
                Ok(file) => {
                    let content = std::str::from_utf8(&file.bytes).map_err(|_| ())?.to_owned();
                    (content, true)
                }
                Err(Some(error)) if error.code == "workspace_file_not_found" => {
                    (DEFAULT_TEMPLATE.to_owned(), false)
                }
                Err(Some(error)) => {
                    return respond(
                        error.status,
                        json!({"ok":false,"error":error.message,"code":error.code}),
                    )
                }
                Err(None) => return Err(()),
            };
        respond(
            StatusCode::OK,
            json!({"ok":true,"contentHash":format!("{:x}",Sha256::digest(content.as_bytes())),"content":content,"exists":exists,"path":path}),
        )
    })();
    result.unwrap_or_else(|_| unavailable())
}
