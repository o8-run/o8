//! Compatibility binary; the primary o8d executable serves the same MCP mode.
#[tokio::main(worker_threads = 2)]
async fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if o8d::mcp::run(&arguments).await.is_err() {
        eprintln!("o8d MCP failed: verify opt-in, listener and upstream");
        std::process::exit(1);
    }
}
