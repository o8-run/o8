# Seed directives

Example directive markdown files in the `~/.o8/directives/` format. Each file has YAML-style
front matter — see `src/app/api/cortex/directives/route.ts` for the parser.

Front-matter fields:

| key       | required | meaning                                                    |
| --------- | -------- | ---------------------------------------------------------- |
| `id`      | yes      | Stable, deterministic. Used for dedupe on re-seed.         |
| `title`   | yes      | One-line summary surfaced in the Recall Card chip.         |
| `scope`   | yes      | `global`, `project`, `repo`, or a repo name.               |
| `repoName`| no       | Required when `scope` is repo-specific.                    |
| `projects`| no       | Project slugs for `scope: project`, e.g. `[o8]`.           |
| `projectIds`| no     | Project ids for `scope: project`, e.g. `[default]`.        |
| `priority`| no       | Higher = more important. Recall Card sorts desc.           |
| `created` | yes      | ISO timestamp.                                             |
| `updated` | yes      | ISO timestamp.                                             |

Body text lives below the second `---` and is the directive content the
orchestrator injects into dispatch packets.

The seed files use stable `id`s prefixed with `seed-` so re-running the
seeding script never duplicates them — the script skips any file whose `id`
already exists in the data dir.
