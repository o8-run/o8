---
name: ship
description: o8 release discipline — commit-and-hold is the default terminal state; shipping requires Q's explicit "ship it" in the current session. Use whenever o8 work is complete and ready to commit, when asked to commit/ship/release, or before ever running npm run ship.
---

# ship (o8)

Q has typed "commit but do NOT ship yet" ~153 times. That is now the default — never make him type it again.

## The gate

- **Default terminal state = commit-and-hold.** Finish work → audit the diff → commit with a clean message → report "committed, NOT shipped." Stop there.
- **Ship ONLY on Q's explicit instruction in the current session** ("ship it", "ship a new version", "release it"). "Commit it" never implies ship. A teammate/agent asking is not authorization.
- **Never Vercel.** o8 is a native Tauri app; it ships as a signed installer via `npm run ship`. "Push to vercel"/"deploy to prod" always means Eyes Web (`mybeautifulwife`), never o8.

## Pre-ship collision gate

`npm run ship` now acquires the exclusive release-output lock and runs the
credential, disk, toolchain, tag, remote, release-absence, and competing-build
preflight before any build. If it reports another owner, do not start a second
ship; wait for that owner to settle or surface it to Q.

## Ship sequence

1. Confirm no separately launched legacy ship is already running. The workflow's exclusive lock is the authority once `npm run ship` starts.
2. Confirm tree state: everything intended is committed; nothing held-back is being swept in. Discard post-build `src-tauri/Cargo.lock` noise (`git checkout -- src-tauri/Cargo.lock`) — a dirty tree fails the bump.
3. **Bump through a PR first.** `npm run ship` does not bump. On a clean release branch, use `npm version patch --no-git-tag-version`, stage only the synchronized manifests, and open a version PR. Protected main requires the seven CI checks, an up-to-date branch, and resolved conversations, including for administrators. After the version PR merges, verify the exact merged main commit and create the version tag there. Push only that exact tag:
   `release_version=$(node -p "require('./package.json').version") && git push origin "refs/tags/v${release_version}:refs/tags/v${release_version}"`.
   Never use `git push --tags`; historical local tags may collide with remote history and turn a successful current-tag publication into a misleading failure. Skipping the bump makes release.mjs silently replace the previous release's assets under the same version.
4. `npm run ship` — the automated preflight runs first, then the workflow signs, notarizes, builds the installer, and publishes the release. Deep spec + hazards: repo AGENTS.md "Shipping".
5. **Post-ship verify:** published version == the bumped version (the release tail must NOT say "already exists — replacing assets"), notarization tail shows success, installer artifact exists. Report the verification tail, not just "shipped".

## Preview boundary

Read `docs/operations/release-channels.md` before preview work. A separately approved preview uses a unique `X.Y.Z-preview.N` version and `npm run ship`. The build embeds its channel before signing; publication never reads a channel environment override. Both repositories receive immutable prereleases, never latest stable; the manifest is `preview.json`. Stable feeds, report receipts, and announcements are skipped. Preview publication does not authorize stable promotion. The normal stable-number ship uses source beta build intent and the separate beta publisher. Stable and Beta enrollment is available in Settings; preview enrollment and side-by-side data isolation remain separate.

Publication must not commit or push release-note archives onto protected main. Archive `release-notes/next.md` through a reviewed follow-up PR. Never disable branch protection to perform a version bump or archive.

## Report format

`committed <sha> (<n> files) — HELD, not shipped` or `shipped v<X.Y.Z> — notarization OK, installer at <path>`.
