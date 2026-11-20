# Root dependency cache

CI restores root `node_modules` only for an exact identity: lockfile, package
configuration, actual Node/npm versions, OS, architecture, runner image family,
postinstall script, patches and cache recipe. Different directories or install
flags require separate identities; nested fixture installs still run normally.

The composite in `.github/actions/node-modules-cache/action.yml` serves native
setup. `ci.yml` repeats its steps inline so the Actions job API exposes install
time separately. The local coverage guard requires identical shapes, and local
verification runs the same native-load probe against installed dependencies.

A successful main job seeds the default-branch cache. Successful PR jobs may save
only in their merge-ref scope, which enables a later push to that same PR to prove
a warm restore without allowing PR contents to seed main.

Cold proof: [CI run 44020546020](https://github.com/o8-run/o8/actions/runs/44020546020),
head `2847535cc6e5a9e612b2529e774f795c219cefcb`, passed. All four active PR jobs
reported an exact cache miss. The audit's install-step durations were:

| Job | npm ci |
|---|---:|
| Type Check | 23 s |
| Lint | 20 s |
| Test Classification | 43 s |
| Security Audit | 36 s |

Every native-load probe passed. Workflow wall time was 327 seconds. This receipt
commit keeps the cache identity unchanged so its own PR run can measure a warm
restore. Run the audit from the audit-script PR with `--run 44020546020 --run ID
--json FILE` to compare runs. Cache hit messages and the native PASS lines in job
logs establish cache state; timestamps alone do not.

A cold/warm pair does not establish a sustained 95% hit rate. Measure at least
30 PR runs after main seeds the cache. Merge queue and native jobs require their
own measurements; their existing test and Rust-cache behavior is retained.
