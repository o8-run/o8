use super::feed::ReadError;
use crate::client::Client;
use serde_json::Value;

impl Client {
    /// Activity keeps HTTP refusals separate from transport failures so a denied
    /// detail read can retain its snapshot and respect the server's cooldown.
    pub(crate) fn activity_request(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Value, ReadError> {
        let mut url = self.url(path).map_err(|_| ReadError::invalid())?;
        let origin = self.url("/").map_err(|_| ReadError::invalid())?;
        if url.origin() != origin.origin() || !path.starts_with("/api/") {
            return Err(ReadError::invalid());
        }
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        let request = self.request(method, &url);
        let response = match body {
            Some(body) => request.send_json(body.clone()),
            None => request.call(),
        };
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(status, response)) => {
                let retry = response
                    .header("Retry-After")
                    .and_then(|s| s.parse::<u64>().ok())
                    .filter(|n| *n > 0)
                    .unwrap_or(300);
                let payload = Self::read::<Value>(response).ok();
                let reason = payload
                    .as_ref()
                    .and_then(|v| v["error"].as_str().or(v["error"]["message"].as_str()))
                    .unwrap_or("Server refused this request")
                    .chars()
                    .take(400)
                    .collect::<String>();
                return Err(ReadError {
                    message: format!("{reason} (HTTP {status})"),
                    status: Some(status),
                    retry,
                });
            }
            Err(_) => {
                return Err(ReadError {
                    message: "Could not reach the selected server".into(),
                    status: None,
                    retry: 0,
                });
            }
        };
        let status = response.status();
        let mut value: Value = Self::read(response).map_err(|_| ReadError::invalid())?;
        if status == 202
            && let Some(object) = value.as_object_mut()
        {
            object.insert("inProgress".into(), Value::Bool(true));
        }
        if value
            .get("error")
            .is_some_and(|v| !v.is_null() && v != false && v != "")
        {
            return Err(ReadError {
                message: "Server could not complete this request. Retry to check again.".into(),
                status: Some(status),
                retry: 0,
            });
        }
        Ok(value)
    }
}
