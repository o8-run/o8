//! Drive the rail's production client construction and mutation dispatch over HTTP.
// The transport reexports these UI-only types; mutations do not use them.
mod shell {
    pub mod session {
        pub struct Session;
        pub struct QueueError;
    }
}
#[path = "../../../src/client.rs"]
mod client;
#[path = "../../../src/surfaces/sidebar/thread_mutations_client.rs"]
mod thread_mutations_client;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 4);
    let result = client::Client::new(&args[0]).and_then(|client| {
        client.mutate_sidebar(
            Some(&args[1]),
            &args[2],
            serde_json::json!({"clientMutationId":args[3]}),
        )
    });
    println!(
        "{}",
        match result {
            Ok(()) => serde_json::json!({"ok":true}),
            Err(error) => serde_json::json!({"ok":false,"error":error}),
        }
    );
}
