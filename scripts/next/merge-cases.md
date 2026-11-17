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
