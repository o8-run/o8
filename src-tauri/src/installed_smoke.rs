use tauri::{Runtime, Webview};

/// Runs only after native-test isolation has been validated by the shell.
/// This acknowledgment works in packaged builds without the optional control plugin.
pub(crate) fn observe_window<R: Runtime>(webview: &Webview<R>, token: &str) {
    let Ok(run_id) = std::env::var("O8_INSTALLED_SMOKE_RUN") else {
        return;
    };
    if std::env::var("O8_PRESHIP_GATE").as_deref() != Ok("1")
        || run_id.len() != 36
        || !run_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return;
    }
    let config = serde_json::json!({
        "runId": run_id,
        "version": env!("CARGO_PKG_VERSION"),
        "token": token,
    });
    let script = r#"(function(){
      const config=__CONFIG__;
      let attempts=0;
      async function observe(){
        if(++attempts>6000)return;
        const root=document.documentElement, workspace=document.querySelector('[data-o8-workspace]');
        if(!location.pathname.includes('/dashboard') || root?.getAttribute('data-o8-dashboard-hydrated')!=='1'
          || root?.getAttribute('data-o8-mount-error')==='1' || !workspace || workspace.offsetWidth<=0 || workspace.offsetHeight<=0){
          setTimeout(observe,100);return;
        }
        try{
          const response=await fetch('/api/panel/installed-smoke/window',{method:'POST',
            headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.token},
            body:JSON.stringify({runId:config.runId,version:config.version,ready:true})});
          if(response.ok)return;
        }catch{}
        setTimeout(observe,100);
      }
      observe();
    })()"#.replace("__CONFIG__", &config.to_string());
    if webview.eval(script).is_err() {
        log::warn!("[installed-smoke] native window acknowledgment unavailable");
    }
}
