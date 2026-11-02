---
name: reports
description: The o8 user bug queue — see what real users reported, what's been tried, and close the loop so they find out. Use BEFORE any o8 ship, when asked "what did users report / what's open / any bugs", when fixing a user-reported bug, and whenever a fix attempt fails. Q will not remember report ids or the commit trailer; the agent must.
---

# reports (o8)

Real users file bugs from the app (⌘⇧E). **Q will not remember report ids, and should not have to.** You will.

The one rule: **nobody who reports a bug gets left in silence.** Fixed, can't-reproduce, need-more-info — they hear *something*. Silence is the failure mode this whole system exists to prevent.

## See the queue

```bash
npm run reports          # syncs the intake channel, then prints the queue
```

Open reports first, oldest first. Each row shows the id, the reporter's own words, who filed it, the version, and the last note. **Run this before every ship** — a fix that's about to go out for an open report should carry its trailer.

```bash
npm run reports -- show FYPPHK    # one report + its full history
```

## Close one: the commit trailer

When you fix a reported bug, put this in the **commit body**:

```
fix(chat): commands popup stays up after clearing the composer

Fixes-Report: FYPPHK
```

That single line is the entire workflow. At ship time it ships the fix in `fixed.json`, so **the reporter's own app tells them** — *"You reported this — it's fixed."* (The public `#fixed` Discord channel was retired on 2026-10-28.)

Multiple ids: `Fixes-Report: FYPPHK, B2M9QP`.

**Never set `fixed` by hand.** The trailer is the only path, so the code and the receipt can't disagree. The CLI refuses.

## Tried and failed? Say so.

This is the part that gets skipped, and it's the part that matters. If you attempted a fix and it didn't work, or you can't reproduce it, **record it** — otherwise that person waits forever for a reply that never comes.

```bash
npm run reports -- note FYPPHK "tried resetting on blur — popup still sticks on Escape"
npm run reports -- status FYPPHK attempted --note "two passes, root cause is deeper than the composer"
npm run reports -- status FYPPHK needs-info --note "which macOS? can you screen-record it?"
npm run reports -- status FYPPHK cant-reproduce --note "clean 0.1.593 on Sequoia, popup dismisses fine"
npm run reports -- status FYPPHK wont-fix --note "by design — the menu stays for chained commands"
```

Every note is mirrored to a **thread on the original report** in the intake channel, so the trail lives where the report does and survives this machine.

### Nothing raw ever goes public

The report's private half — **screenshot, crash traces, repo paths, OS** — lives only in the intake channel, which denies `@everyone`. It never goes anywhere else.

The reporter's **prose** is the part that used to leak: it was republished verbatim to `#fixed` **and to `fixed.json`, a world-readable GitHub URL**. So before anything is published, the title is sanitized:

1. `redact()` — deterministic. Strips paths, emails, URLs, IPs, @handles, keys. **Always runs.**
2. A **free** model (`openai/gpt-oss-20b:free`, $0) rewrites the redacted text into a neutral bug title.

The model is the polish, never the guard — if OpenRouter is down we publish the redacted text, **never the raw text**. `buildManifest` redacts unconditionally on the way out as a final gate, so raw prose physically cannot reach the manifest even if an upstream path forgets.

```
raw    (private):  "the diff panel crashes when I open /Users/bob/clients/acme-secret"
public (fixed.json): "Diff panel crashes when opening file"
```

The **reporter still sees their own words** — their app reads the raw title from its own local ledger and only falls back to the public one. They get "you reported this — <what you actually said>"; the world gets the clean line.

### What the reporter actually sees

The fix manifest is a **public** download, so we publish **wins and asks — never wounds**:

| status | reporter sees it? |
|---|---|
| `fixed` | **Yes** — green card in their app |
| `needs-info` | **Yes** — amber card in their app, with your note as the ask |
| `attempted` · `cant-reproduce` · `wont-fix` · `triaged` | **No** — internal only |

`needs-info` is the important one: it's how you ask a reporter for help, and it's the single most valuable thing to say to someone whose bug you can't reproduce. **Always give it a `--note`** — "we need something" without saying *what* is worse than silence.

A public list of "o8 won't fix these" is exactly the rot board we refused to build. That's why the other statuses stay internal.

## Retroactive is fine

Notes and statuses can be added to any report at any time, including ones fixed long ago. Nothing about this is append-once.

## Setup (already done on Q's machine)

- Bot token: `~/.o8/discord-bot-token` (0600) or `O8_DISCORD_BOT_TOKEN`. **Never `o8.release.json`** — that file gets baked into the packaged app.
- Without the token you still get the local ledger, but you won't see reports filed by *other people*, and notes won't mirror. Say so rather than pretending the queue is empty.

## Why the sync exists (don't remove it)

A report is recorded on the machine that **filed** it. A user's report lands in *their* ledger, never ours. `publish:fixed` and `release.mjs` therefore sync the intake channel into the local ledger **first** — without it, every fix we ship for someone else's bug resolves to "unknown report id" and is silently dropped. That bug shipped once already.

## Related

- `.claude/skills/ship/SKILL.md` — the release gate. Check this queue before shipping.
- Doctrine + full reasoning: vault `[[o8-feedback-loop-doctrine]]`.
