# Adding a judgment surface

Each surface owns a module under `src/lib/judgment/questions/`. Keep its locked
question text, thresholds and calibration notes together. Callers import that
module directly. `questions.ts` preserves existing imports; adding a surface
does not require appending another export there.

Each replay label owns a module under `scripts/judgment-labels/`. The replay
command discovers these modules from the directory. Its help, argument
validation and `all-recorded` selection come from those descriptors.

A recorded label exports this shape as its default export:

```js
const replayLabel = {
  name: 'sampleSurface',
  kind: 'recorded',
  load: async ({ dbPath, dataDir }) => readRecordedHistory(dbPath, dataDir),
  label: history => labelRecordedAnswers(history),
  render: labeled => renderMeasuredReport(labeled),
};
export default replayLabel;
```

The surface supplies the three functions. `load` reads existing history, `label`
returns `{ rows, notes }`, and `render` returns `{ text, result }`. An optional
`source(paths)` names a different source in a read failure. An optional numeric
`order` preserves an established report order; otherwise labels sort by name
after the existing labels. Equal orders also sort by name. Duplicate names and
incomplete descriptors fail explicitly.

Keep question imports inside `load` when a replay module needs a TypeScript
question definition. Discovery also runs before the command's TypeScript loader
starts, so module evaluation itself uses JavaScript imports.

The three existing approval labels retain their existing replay implementation.
The named renderer exports in `judgment-replay.mjs` are compatibility exports;
they do not register labels. A new recorded label does not add an import,
constant, help entry, validation branch or dispatch branch to that file.

Verify discovery with `node scripts/judgment-replay.mjs --help` and replay the new
label through `--label`. Run `npm run test:classify` after adding tests. A new
lane event verb still belongs in the central lane event union.

`tests/judgment-surface-merge-real-path.test.ts` adds two independent question and
label modules on separate temporary Git branches, merges them in both orders,
and exercises discovery and replay through the real command.
