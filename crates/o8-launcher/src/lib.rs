#![cfg(unix)]
/// Writes a line to standard error, ignoring failures. `eprintln!` panics when
/// standard error is a closed pipe, which must never stop a shutdown or a start.
#[macro_export]
macro_rules! note {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}
pub mod ownership;
