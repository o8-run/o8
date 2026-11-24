# Repository instruction split

The always-on [AGENTS.md](../../AGENTS.md) keeps outcome ownership, authority, non-mutation,
preservation, evidence, blocker reporting, verification scope, and explicit skill routes.
It is 1918 bytes, under the strict 2000-byte budget. The original file was 7287 bytes.
Six task skills use the repository's existing folder and frontmatter format
(`.agents/skills/<name>/SKILL.md`). No model, effort, tool, hook, automation, or
permission default changes.

## Routing decision

Load a skill when its trigger matches, before the relevant work. The core provides direct links,
so discovery does not depend on a runtime automatically scanning skill folders.

| Task boundary | Skill |
| --- | --- |
| Inspect or change code, routing, APIs, model calls, or architecture | `o8-code` |
| UI, TSX, style, hooks, icons, and interaction work | `o8-ui` in addition to code rules |
| Select or run code, process, persistence, or documentation checks | `o8-checks` |
| Issues, PRs, commits, packet scope, and CLI/proof references | `o8-contribute` |
| Delegation, concurrent agents, high-risk evidence, or control-plane recovery | `o8-delegate` |
| Version or release work | `o8-release`, then the existing release skill and relevant runbook |

Read-only diagnosis remains non-mutating. The core's typecheck instruction applies to code changes;
it does not add a build or test requirement to diagnosis. Skill instructions preserve the original
scope of completion checks. A current task's explicit constraints still take precedence.

## File and fixed-task sizes

Use `ceil(UTF-16 characters / 4)`, the existing repository approximation. UTF-8 byte counts enforce
the core budget. These are instruction-file budgets, not provider usage or completed-task cost.
The table includes full selected skill files, including their trigger metadata.

| Instruction file | UTF-8 bytes | Approximate tokens |
| --- | ---: | ---: |
| Core (`AGENTS.md`) | 1918 | 480 |
| [o8-code](../../.agents/skills/o8-code/SKILL.md) | 1713 | 429 |
| [o8-ui](../../.agents/skills/o8-ui/SKILL.md) | 580 | 145 |
| [o8-checks](../../.agents/skills/o8-checks/SKILL.md) | 844 | 211 |
| [o8-contribute](../../.agents/skills/o8-contribute/SKILL.md) | 1158 | 290 |
| [o8-delegate](../../.agents/skills/o8-delegate/SKILL.md) | 2131 | 533 |
| [o8-release](../../.agents/skills/o8-release/SKILL.md) | 428 | 107 |

The following fixed task types hold the requested work category constant. PR-producing tasks
include the contribution and verification skills. Release preparation includes the existing
release skill on both sides. Runtime catalog metadata, project instructions, and named external
skills can add context; automatic metadata discovery depends on the runtime. These are file-load
scenarios, not recorded model task executions.

| Fixed task | Loaded task skills | Before ~tokens | After ~tokens | Effort / outcome |
| --- | --- | ---: | ---: | --- |
| Read-only runtime diagnosis | o8-code | 1822 | 908 | Unchanged; not measured |
| API implementation and PR | o8-code, o8-checks, o8-contribute | 1822 | 1409 | Unchanged; not measured |
| UI implementation and PR | o8-code, o8-ui, o8-checks, o8-contribute | 1822 | 1554 | Unchanged; not measured |
| Documentation and PR | o8-checks, o8-contribute | 1822 | 981 | Unchanged; not measured |
| Delegation planning | o8-delegate | 1822 | 1013 | Unchanged; not measured |
| Release preparation | o8-release + existing release skill | 2777 | 1542 | Unchanged; not measured |

Completion rate, review findings, actual per-task usage, effort-versus-acceptance, and latency were
not measured. No outcome improvement or allowance saving is claimed. Loading every skill together
is not a token-saving workflow; their boundaries matter.

## Rule retention check

[scripts/agent-rule-coverage.json](../../scripts/agent-rule-coverage.json) records the original
file's commit, SHA-256, byte count, and all 30 rule units. A unit is a non-heading paragraph or
list item with its wrapped continuation lines. Six units remain in the core; 24 moved to skills.

[scripts/check-agent-rules.mjs](../../scripts/check-agent-rules.mjs) checks the core's byte budget,
every rule's destination and content, all six core links, and each skill's name and trigger.
Whitespace and relative links are normalized. The GitHub-standard locator is the only portable
slot: the surrounding privacy and history rules remain in the same digest. Its old private
locator now points to the existing repository workflow document. Every source and destination
rule digest must match; there is no general rewrite exception.

The default check uses the included manifest and needs neither network access nor full Git history.
To audit the manifest against the full rule file as well, fetch the published pre-rebase revision
that records the intentional R19 update:

```sh
git fetch origin 5e5a45d8b515c366cba49f9fdae32c11ed466448
git show 5e5a45d8b515c366cba49f9fdae32c11ed466448:AGENTS.md > /tmp/agents-before.md
node scripts/check-agent-rules.mjs --baseline-file /tmp/agents-before.md
node scripts/check-agent-rules.mjs
```

The initial baseline-file run verified all 30 original units. The current baseline intentionally
updates R19 for `npm run typecheck:fast`, the tsc 5.8 fallback on Intel Macs and Windows, and the
`npm run typecheck:tsc` cross-check. Both R19 digests and the baseline commit, byte count, and file
digest were refreshed from the full pre-compaction rule file; the other 29 rule digests are unchanged.
Treat changes to the coverage manifest as policy changes that require review, rather than a way
to clear a failed check.

| Original rule unit | Current destination |
| --- | --- |
| R01 | [AGENTS.md](../../AGENTS.md) |
| R02 | [AGENTS.md](../../AGENTS.md) |
| R03 | [AGENTS.md](../../AGENTS.md) |
| R04 | [AGENTS.md](../../AGENTS.md) |
| R05 | [AGENTS.md](../../AGENTS.md) |
| R06 | [AGENTS.md](../../AGENTS.md) |
| R07 | [.agents/skills/o8-delegate/SKILL.md](../../.agents/skills/o8-delegate/SKILL.md) |
| R08 | [.agents/skills/o8-delegate/SKILL.md](../../.agents/skills/o8-delegate/SKILL.md) |
| R09 | [.agents/skills/o8-delegate/SKILL.md](../../.agents/skills/o8-delegate/SKILL.md) |
| R10 | [.agents/skills/o8-delegate/SKILL.md](../../.agents/skills/o8-delegate/SKILL.md) |
| R11 | [.agents/skills/o8-delegate/SKILL.md](../../.agents/skills/o8-delegate/SKILL.md) |
| R12 | [.agents/skills/o8-delegate/SKILL.md](../../.agents/skills/o8-delegate/SKILL.md) |
| R13 | [.agents/skills/o8-code/SKILL.md](../../.agents/skills/o8-code/SKILL.md) |
| R14 | [.agents/skills/o8-code/SKILL.md](../../.agents/skills/o8-code/SKILL.md) |
| R15 | [.agents/skills/o8-code/SKILL.md](../../.agents/skills/o8-code/SKILL.md) |
| R16 | [.agents/skills/o8-code/SKILL.md](../../.agents/skills/o8-code/SKILL.md) |
| R17 | [.agents/skills/o8-ui/SKILL.md](../../.agents/skills/o8-ui/SKILL.md) |
| R18 | [.agents/skills/o8-code/SKILL.md](../../.agents/skills/o8-code/SKILL.md) |
| R19 | [.agents/skills/o8-checks/SKILL.md](../../.agents/skills/o8-checks/SKILL.md) |
| R20 | [.agents/skills/o8-checks/SKILL.md](../../.agents/skills/o8-checks/SKILL.md) |
| R21 | [.agents/skills/o8-checks/SKILL.md](../../.agents/skills/o8-checks/SKILL.md) |
| R22 | [.agents/skills/o8-contribute/SKILL.md](../../.agents/skills/o8-contribute/SKILL.md) |
| R23 | [.agents/skills/o8-contribute/SKILL.md](../../.agents/skills/o8-contribute/SKILL.md) |
| R24 | [.agents/skills/o8-delegate/SKILL.md](../../.agents/skills/o8-delegate/SKILL.md) |
| R25 | [.agents/skills/o8-contribute/SKILL.md](../../.agents/skills/o8-contribute/SKILL.md) |
| R26 | [.agents/skills/o8-code/SKILL.md](../../.agents/skills/o8-code/SKILL.md) |
| R27 | [.agents/skills/o8-ui/SKILL.md](../../.agents/skills/o8-ui/SKILL.md) |
| R28 | [.agents/skills/o8-release/SKILL.md](../../.agents/skills/o8-release/SKILL.md) |
| R29 | [.agents/skills/o8-delegate/SKILL.md](../../.agents/skills/o8-delegate/SKILL.md) |
| R30 | [.agents/skills/o8-delegate/SKILL.md](../../.agents/skills/o8-delegate/SKILL.md) |

## Verification

The real CLI tests check the actual core and skills, then use isolated copies to prove that
removing an authority rule, weakening verification, refreshing a weakened privacy-rule hash,
exceeding the core budget, dropping a skill route, or removing a trigger makes the check fail.
The existing programmatic-prompt tests still recognize outcome ownership through AGENTS.md.
All six skills passed frontmatter and scaffold validation. Local links and test classification
are checked as well. The full local test suite is intentionally outside this task's checks.
