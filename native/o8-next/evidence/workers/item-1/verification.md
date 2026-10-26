# Filter and live-list verification

The real-shell GPUI test first failed at the absent task-card selector. The production-route host test first returned 404 for lanes. After implementation, both native tests and the route test pass. Red and green tails are adjacent.

The full native suite ran after rebasing onto `a0b4f4f10`: 163 passed, 2 failed, 3 ignored. One failure was the absent optional local-server binary. The other is the Activity palette adjacency assertion: it expects Open diff immediately after Activity but main registers Open pull requests there. The same assertion fails on clean `a0b4f4f10` without this surface. That upstream assertion remains open; the Workers registration is ordered after existing commands.

`cargo clippy --all-targets --locked`, the isolated surface-boundary build, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`, `npm run typecheck:fast`, the touched route test, ESLint and the changed-file rule check pass. `npm run test:classify` passes, including its five isolated dated-fixture probes. The broad hermetic suite ran before the main rebase: 1,243 files and 9,075 tests passed. Focused routes, type checks and native checks were repeated on the rebased patch.

The native PNG is an actual frame captured in a private virtual display with software rendering. The reference PNG renders the existing desktop worker header, transcript, pane frame and composer with their All Glass theme and the same blocked-task text. The native view currently uses the shared dark fallback. macOS system material and exact visual parity remain unverified. Card activity and actions are subsequent items.
