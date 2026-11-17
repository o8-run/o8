# Transcript merge differential corpus

`tests/next-merge-differential-real-path.test.ts` imports the current TypeScript merge entry
point directly. It needs neither a browser console nor the removed WebSocket
provider used by `tests/next-stream-parity.test.ts` before #6166.

The default seed is 6327. Regenerate the TypeScript oracle and check both mergers:

```sh
O8_MERGE_WRITE=1 npx vitest run tests/next-merge-differential-real-path.test.ts
npx vitest run tests/next-merge-differential-real-path.test.ts
cargo test --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next merge::tests::production_web_merge_cases
```

The Rust test reads the fixture at runtime, so recording does not rebuild the binary.
Use `O8_MERGE_SEED=<unsigned decimal u32>` on both TypeScript commands to explore
another seed. Restore the default corpus before committing. Case names carry the
seed and generated index; diagnostics also carry the fixture index and first JSON
pointer. The first five hand-written inputs and names remain in place, but their
expected results now come from the current TypeScript oracle.

Known differences pin both outputs: a change to either implementation fails its
check, and a resolved difference fails with a request to remove the exception.
Recording differences is an explicit maintenance operation, never enabled in CI.
The committed corpus has 305 cases and zero known differences after the #6328
port. The normal Rust test checks every case against the TypeScript result.
For diagnosis only, `O8_MERGE_RECORD_DIFFERENCES=1` on the Rust command records
linked exceptions; do not commit an exception without an issue explaining it.

## Recorded streams

`tests/next-stream-differential-real-path.test.ts` discovers the recordings used by
Rust's `recorded_streams_match_web` test. It mounts the current desktop WebSocket
provider and feeds each recorded frame through its boot, sequence and capture
filters, `wireWsBridge`, and `mergeTranscriptEntries` (the live caller's
`mergeTranscriptSources` plus 200-entry retention). It compares final entry IDs,
order and text with `*.entries.json`, and checks the same IDs/order in `*.tree.json`.
The transport alone is fake; no removed replay provider is needed.

Regenerate the entry expectations explicitly, never in CI:

```sh
O8_STREAM_WRITE=1 npx vitest run tests/next-stream-differential-real-path.test.ts
```

These recordings also contain rendered rows. TypeScript owns the entry oracle,
not a renderer. Keep the native rendering expectation checked by the Rust test.
When entry changes require new rows, use the existing native renderer on the
TypeScript-generated entries, review the row diff, then check both paths:

```sh
for case in stream stream-edges; do
  cargo --config 'profile.dev.package.o8-next.opt-level=0' --config 'profile.dev.package.o8-next.debug=0' run --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next -- --render-tree "native/o8-next/fixtures/$case.entries.json" > "/tmp/$case.tree.json" || exit
  cp -- "/tmp/$case.tree.json" "native/o8-next/fixtures/$case.tree.json"
done
npx vitest run tests/next-stream-differential-real-path.test.ts
cargo --config 'profile.dev.package.o8-next.opt-level=0' --config 'profile.dev.package.o8-next.debug=0' test --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next stream::tests:: -- --test-threads=4
```

Do not regenerate rows from the native stream merger to hide a port difference.
The entry oracle must come from TypeScript first. Rendering changes require a
separate explanation; regeneration is not independent proof of rendering parity.
The `stream-edges` update for #6328 retains `long-21` through `long-118` before
`long-119` and `long-120`: frame 9 (sequence 4 after the boot reset) is a
non-replace overlapping window, so the current ID-ordering merger retains all
100 entries. The old recording kept only the last two. `stream` is unchanged.
