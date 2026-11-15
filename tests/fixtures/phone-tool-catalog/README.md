The parity fixture records the 42 static tools in the union of the two phone packs.
It was produced from the JSON literals inside `all_tools()` in
`src-tauri/src/agent/tools/mod.rs` and the explicit match arms of
`tool_safety_class()` in `src-tauri/src/agent/safety.rs`.

The initial extraction decoded all 105 static `json!` objects as JSON (no Rust
build), required 42 unique selected names, and required an explicit safety match
for every selected name. No dynamic schemas were included. Descriptions and
parameters were copied without edits, including optional fields and enums.

Each schema fingerprint is SHA-256 of UTF-8 JSON with recursively sorted object
keys, original array order, no extra whitespace, and literal Unicode. Each class
is the corresponding Rust match result. The two source fingerprints are SHA-256
of the complete original file bytes. Tests compare both the server catalog and
policy to the fixture, and pin the Rust sources while `src-tauri` exists.
This deliberately fails on unrelated source edits too, instead of silently
missing a change that a partial Rust parser does not recognize.

To refresh after a Rust change, review the complete source diff, decode the static
JSON objects again, assert the complete count and exact phone-name union, and
compare every selected schema and class before updating the fingerprints and
server modules together. Do not simply accept new source hashes. When the classic
shell is deleted, the schema and class fingerprints remain the migration baseline.
