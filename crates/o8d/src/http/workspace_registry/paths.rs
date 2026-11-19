//! Raw project path edits retain opaque fields and malformed records.
use serde_json::Value;
use std::path::{Path,PathBuf,Component};
pub(super) fn normalize(input:&str)->String{
    let input=input.trim();
    let home=std::env::var("HOME").unwrap_or_default();
    let expanded=if input=="~" {home.clone()}else if let Some(rest)=input.strip_prefix("~/"){format!("{home}/{rest}")}else{input.into()};
    let path=Path::new(&expanded);
    let path=if path.is_absolute(){path.into()}else{std::env::current_dir().unwrap_or_default().join(path)};
    let mut result=PathBuf::new();
    for part in path.components(){match part{Component::ParentDir=>{result.pop();},Component::CurDir=>(),p=>result.push(p.as_os_str())}}
    result.to_string_lossy().into_owned()
}
pub(super) fn mutate(ledger:&mut Value,previous:&str,next:Option<&str>){
    let previous=normalize(previous);let next=next.map(normalize);
    if let Some(projects)=ledger["projects"].as_array_mut(){
        for project in projects{
            let Some(paths)=project.get_mut("repoPaths").and_then(Value::as_array_mut)else{continue;};
            let old=std::mem::take(paths);
            for candidate in old{
                let value=if candidate.as_str().is_some_and(|p|normalize(p)==previous){
                    let Some(next)=next.as_ref()else{continue;};Value::String(next.clone())
                }else{candidate};
                if !paths.contains(&value){paths.push(value);}
            }
        }
    }
}
#[cfg(test)]mod tests{
 use super::*;use serde_json::json;
 #[test]fn raw_path_edits_keep_opaque_and_malformed_records(){
  let mut value=json!({"opaque":true,"projects":[null,{"bad":true},{"extra":"keep","repoPaths":["/tmp/a"," /tmp/a ","/tmp/b",17]}]});
  mutate(&mut value,"/tmp/a",Some("/tmp/b"));assert_eq!(value,json!({"opaque":true,"projects":[null,{"bad":true},{"extra":"keep","repoPaths":["/tmp/b",17]}]}));
  mutate(&mut value,"/tmp/b",None);assert_eq!(value["projects"][2]["repoPaths"],json!([17]));
 }
}
