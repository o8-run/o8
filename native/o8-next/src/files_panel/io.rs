//! FileViewer's existing repo-scoped and operator absolute-file routes.
use crate::client::Client;
use serde_json::{Value, json};
#[derive(Debug)]
pub(super) enum SaveError {
    Conflict,
    Message(String),
}
fn response(result: Result<ureq::Response, ureq::Error>) -> Result<Value, String> {
    let (ok, response) = match result {
        Ok(r) => (true, r),
        Err(ureq::Error::Status(_, r)) => (false, r),
        Err(_) => return Err("Could not reach the selected server.".into()),
    };
    let body: Value = Client::read(response)?;
    if !ok || body["error"].as_str().is_some() {
        return Err(body["error"]
            .as_str()
            .unwrap_or("Unable to save file.")
            .into());
    }
    Ok(body)
}
pub(super) fn read(client: &Client, workspace: &str, path: &str) -> Result<Value, String> {
    read_version(client, workspace, path, true)
}
fn read_version(
    client: &Client,
    workspace: &str,
    path: &str,
    preview: bool,
) -> Result<Value, String> {
    let absolute = std::path::Path::new(path).is_absolute();
    let mut url = client
        .url(if absolute {
            "/api/panel/file-io"
        } else {
            "/api/v2/files"
        })
        .map_err(|_| "Invalid file route")?;
    url.query_pairs_mut().append_pair("path", path);
    if !absolute {
        url.query_pairs_mut().append_pair("workspace", workspace);
        if preview {
            url.query_pairs_mut().append_pair("preview", "1");
        }
    }
    response(
        client
            .request("GET", &url)
            .timeout(std::time::Duration::from_secs(30))
            .call(),
    )
}
pub(super) fn save(
    client: &Client,
    workspace: &str,
    path: &str,
    original: &str,
    content: &str,
    mtime: Option<f64>,
) -> Result<Option<f64>, SaveError> {
    let absolute = std::path::Path::new(path).is_absolute();
    // Reuse the existing server hash/mtime guards; never force a stale draft.
    let current = read_version(client, workspace, path, false).map_err(SaveError::Message)?;
    if current["truncated"] == true || current["content"].as_str() != Some(original) {
        return Err(SaveError::Conflict);
    }
    let (write_path, file_io, expected_mtime) = if absolute {
        (
            path.to_owned(),
            true,
            mtime.or_else(|| current["mtimeMs"].as_f64()),
        )
    } else if current["contentHash"].as_str().is_some() {
        (path.to_owned(), false, None)
    } else {
        // Older installed servers expose mtime guards on classic's file-io route.
        let path = std::path::Path::new(workspace)
            .join(path)
            .to_string_lossy()
            .into_owned();
        let version = read_version(client, workspace, &path, false).map_err(SaveError::Message)?;
        if version["content"].as_str() != Some(original) {
            return Err(SaveError::Conflict);
        }
        (path, true, version["mtimeMs"].as_f64())
    };
    if file_io && expected_mtime.is_none() {
        return Err(SaveError::Message(
            "This server could not verify the file revision. Your edits are kept.".into(),
        ));
    }
    let url = client
        .url(if file_io {
            "/api/panel/file-io"
        } else {
            "/api/v2/files"
        })
        .map_err(|_| SaveError::Message("Invalid file route".into()))?;
    let mut body = json!({"path":write_path,"content":content});
    if file_io {
        body["expectedMtimeMs"] = json!(expected_mtime);
    } else {
        body["workspace"] = json!(workspace);
        body["expectedHash"] = current["contentHash"].clone();
    }
    let body = response(
        client
            .request(if file_io { "PUT" } else { "POST" }, &url)
            .timeout(std::time::Duration::from_secs(30))
            .send_json(body),
    )
    .map_err(|error| {
        if error == "changed-on-disk" {
            SaveError::Conflict
        } else {
            SaveError::Message(error)
        }
    })?;
    if (file_io && body["ok"] != true) || (!file_io && body["success"] != true) {
        return Err(SaveError::Message(
            "The server did not confirm the save.".into(),
        ));
    }
    Ok(body["mtimeMs"].as_f64())
}

/// Structured status/body transport shared by notes and the existing Files I/O.
pub(super) fn json_request(
    client: &Client,
    method: &str,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
) -> Result<(u16, Value), String> {
    let mut url = client.url(path).map_err(|_| "Invalid file route")?;
    url.query_pairs_mut().extend_pairs(query.iter().copied());
    let request = client
        .request(method, &url)
        .timeout(std::time::Duration::from_secs(
            if query
                .iter()
                .any(|(k, v)| *k == "action" && matches!(*v, "review" | "scoped-reply"))
            {
                150
            } else {
                30
            },
        ));
    let response = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    };
    let response = match response {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(_) => return Err("Could not reach the selected server.".into()),
    };
    let status = response.status();
    Ok((status, Client::read(response)?))
}
