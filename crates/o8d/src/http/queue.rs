use super::*;

pub(super) fn read(store: &Store, params: &Params) -> Response {
    let repo = value(params, "repoPath");
    let thread = value(params, "threadId");
    if !repo.starts_with('/')
        || repo.len() > 4096
        || !thread.strip_prefix("thoughts-").is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 80
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
    {
        return problem("A valid repository and chat are required.");
    }
    let repo = key(repo);
    let history = store.history(thread).unwrap_or(Value::Null);
    if history["source"] == "bot-network" {
        return unavailable();
    }
    if history["repoPath"]
        .as_str()
        .is_some_and(|s| !s.is_empty() && key(s) != repo)
    {
        return problem("The queued message must target its saved chat repository.");
    }
    if params.contains_key("id") {
        return unavailable();
    } // visual-receipt route is not called by o8 next
    let result = (|| {
        let db = store.database()?;
        let mut query = db.prepare("SELECT sequence,id,repo_path,thread_id,intent,payload_json,status,reason,created_at,updated_at,admitted_at FROM composer_send_queue WHERE repo_path = ? AND thread_id = ? AND (status IN ('queued','dispatching','held') OR sequence IN (SELECT sequence FROM composer_send_queue WHERE repo_path = ? AND thread_id = ? AND intent = 'steer-now' AND status = 'applied' ORDER BY sequence DESC LIMIT 40)) ORDER BY sequence").map_err(|_| ())?;
        let rows = query.query_map([repo.as_str(),thread,repo.as_str(),thread],|r| {
            let payload:String=r.get(5)?;
            Ok(json!({"sequence":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"repoPath":r.get::<_,String>(2)?,"threadId":r.get::<_,String>(3)?,"intent":r.get::<_,String>(4)?,"payload":serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null),"status":r.get::<_,String>(6)?,"reason":r.get::<_,Option<String>>(7)?,"createdAt":r.get::<_,i64>(8)?,"updatedAt":r.get::<_,i64>(9)?,"admittedAt":r.get::<_,Option<i64>>(10)?}))
        }).map_err(|_| ())?;
        let items = rows.collect::<Result<Vec<_>, _>>().map_err(|_| ())?;
        // Live steering is a process capability. Pi's packaged-platform probe and
        // running Codex bridges need TypeScript; do not advertise stale capability.
        if ["pi", "codex"].contains(&value(params, "backend"))
            || items.iter().any(|i| {
                ["pi", "codex"].contains(&i["payload"]["routing"]["backend"].as_str().unwrap_or(""))
            })
        {
            return Err(());
        }
        Ok(json!({"items":items,"canSteer":false,"steerableIds":[]}))
    })();
    match result {
        Ok(v) => reply(StatusCode::OK, v),
        Err(()) => unavailable(),
    }
}
fn key(repo: &str) -> String {
    std::fs::canonicalize(repo)
        .unwrap_or_else(|_| {
            let mut path = PathBuf::new();
            for part in Path::new(repo).components() {
                match part {
                    std::path::Component::ParentDir => {
                        path.pop();
                    }
                    std::path::Component::CurDir => {}
                    part => path.push(part),
                }
            }
            path
        })
        .to_string_lossy()
        .into_owned()
}
