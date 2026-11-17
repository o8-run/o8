# CI timing audit

Run `node scripts/ci/time-audit.mjs 150 --json timings.json` from an authenticated
`gh` checkout. No token configuration beyond `gh` is required. The count is per
event (`pull_request`, `merge_group`, `push`), not a combined sample. Add `--combined` to select the last N workflow runs across
all events, matching a workflow-wide historical sample. Use repeated
`--run ID` arguments to compare specific cold and warm CI runs. `--repo owner/repo`
selects another repository with a `ci.yml` workflow.

All times are seconds. Percentiles use nearest rank. Completed runs include
failures and cancellations; conclusions and individual runs remain in JSON so
comparisons can exclude them explicitly. Job duration includes step gaps; running
time is the sum of non-setup steps. Install includes npm version setup. Composite
actions appear as one setup step in the Actions API, so their inner install and
Rust commands cannot be separated by this report. Queue time starts at job
creation, which may include dependency waiting. Critical path is observed elapsed
time to the last finishing job, including upstream waiting, rather than the sum
of parallel job durations. The API does not expose the resolved dependency DAG.

Do not compare samples without noting their event, time window, conclusions,
source revisions and cache state. Keep JSON as a local artifact when its full
job names or URLs are not needed in a public report.
