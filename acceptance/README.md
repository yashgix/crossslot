# Acceptance tests

Black-box tests of the command line tool and its library exports. They use the shipped files `compose.yaml`,
`patch/crossslot.patch`, `patch/NOTES.md` and `data/`. Each test name starts with the requirement ID it checks. Do not
change this folder to make a failing test pass.

## Run

```
npm run build && npm run acceptance
```

`npm run acceptance` is `vitest run --config acceptance/vitest.config.ts`. Tests that need Docker and the cluster run
only when the gate is set:

```
npm run build && npm run cluster:up && CROSSSLOT_CLUSTER_TESTS=1 npm run acceptance
```

## Inputs

- `data/sim` is the pinned corpus and `data/MANIFEST.sha256` its hashes. `CROSSSLOT_CORPUS` overrides the corpus path.
  The corpus-based tests assert numbers that are true for the pinned commit (for example 71 call sites).
- Fixture tests write small synthetic TypeScript trees into temp directories. Nothing leaves the machine.
- Nothing here talks to Sim, GitHub or any account. The cluster tests talk only to the local Docker containers.

## Test files

| File                                  | Covers                                                           |
| ------------------------------------- | ---------------------------------------------------------------- |
| `tests/m1/slot.test.ts`               | slot function                                                    |
| `tests/m1/scan-fixtures.test.ts`      | scanner on synthetic fixtures                                    |
| `tests/m1/scan-corpus.test.ts`        | scanner on the pinned corpus                                     |
| `tests/m1/corpus.test.ts`             | corpus fetch and hashes                                          |
| `tests/m1/compose.test.ts`            | Compose file                                                     |
| `tests/m1/cluster.test.ts` (gated)    | cluster start and stop                                           |
| `tests/m1/diff.test.ts` (partly gated) | diff report, determinism, controls                              |
| `tests/m1/patch.test.ts`              | patch apply, notes, after-patch results                          |
| `tests/m1/summarize.test.ts`          | summarize command                                                |
