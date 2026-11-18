# crossslot

A Redis Cluster compatibility audit of [Sim](https://github.com/simstudioai/sim).

On Sim's pinned commit `edf5f0a`, 26 of the 40 Redis call sites the harness executed, in 9 of the 13 features it
drives, fail on a real 6-node Redis 8.10.3 cluster. The standalone control has 0 errors.

Sim does not support Redis Cluster today (issue [#9734](https://github.com/simstudioai/sim/issues/9734)). These are
compatibility findings for that request, not production bugs.

Write-up with diagrams and per-feature tables: https://yashgix.github.io/crossslot/

## Why it fails

On a cluster, each multi-key command, Lua script and MULTI block needs all its keys in one hash slot. The failing key
sets tested here lack a common hash tag and span slots in this configuration. Four failure classes show up:

- `CROSSSLOT`: the server refuses a command or script whose keys are in different slots.
- Lua non-local key: a script reads a key it did not declare in `KEYS`, and that key is on another node.
- ioredis client-side pipeline refusal: an explicit pipeline in cluster mode is not split across nodes, so its keys
  must fall in one slot allocation group, and the client refuses it before sending if they do not.
- `MOVED` inside a MULTI: node-redis sends the whole transaction to one node, and a key owned by another node is
  answered with a redirect that cannot be followed inside a transaction.

## Three reproductions

Each script runs code from Sim's pinned commit against a standalone Redis and a 6-node cluster, prints one PASS or
FAIL line per case, and exits nonzero if an outcome is not the expected one. Details are in `repro/README.md`.

| Feature                                    | Command                        | Cluster outcome                 |
| ------------------------------------------ | ------------------------------ | ------------------------------- |
| Token bucket, one `EVAL` over 4 keys       | `npm run repro:token-bucket`   | `CROSSSLOT`                     |
| Hosted-key queue, `MULTI` and a Lua script | `npm run repro:hosted-queue`   | pipeline refusal, non-local key |
| Realtime rooms, `EVALSHA`, `DEL`, `MULTI`  | `npm run repro:realtime-rooms` | `CROSSSLOT`, `MOVED`            |

`npm run repro` runs all three. Expected: 15 PASS, 0 FAIL, exit 0. Outputs of a run are in `results/repro/`.

## Reproduce everything

Needs Node 22.13 or later and Docker with Compose. Dependencies are pinned in `package-lock.json`. The Sim files the
tool reads are a pinned corpus of 175 files, fetched from GitHub and checked against their SHA-256 hashes.

```
npm ci --ignore-scripts
npm run build
node dist/cli.js corpus fetch --out data/sim --manifest data/MANIFEST.sha256
(cd data/sim && shasum -a 256 -c ../MANIFEST.sha256)
node dist/cli.js scan --root data/sim --alias @/=apps/sim --json sites.json
npm run cluster:up
node dist/cli.js diff --corpus data/sim --target cluster --seeds 20 --ops 500 --out before.json
node dist/cli.js patch apply --corpus data/sim --patch patch/crossslot.patch --out data/patched
node dist/cli.js diff --corpus data/patched --reference-corpus data/sim --target cluster --seeds 20 --ops 500 --out after.json
node dist/cli.js summarize --before before.json --after after.json
npm run repro
npm run cluster:down
```

`results/before.json`, `results/after.json` and `results/summary.txt` come from this sequence. Everything binds to
`127.0.0.1`. The harness refuses a Redis host that is not a loopback address, never runs `FLUSHALL` or `FLUSHDB`, and
deletes only the keys it wrote. The Compose project is named `crossslot`, and `cluster down` removes only that
project's containers, networks and volumes.

The scanner lists the Redis calls it can analyse (`eval`, `evalsha`, `multi`, `pipeline` and the multi-key commands,
in the syntax it supports, see `src/scan`). Recognised calls whose scripts or keys cannot be resolved are reported as
`UNRESOLVED`. Unsupported call syntax, for example `redis["eval"](...)`, can be missed. The
`diff` command replays 20 seeds of 500 operations for each of 13 features, the same stream on a standalone Redis and
on the cluster. A call site counts as failing when Redis or the cluster client refuses a call made there.

## Result

| Run    | Features | Failing features | Failing sites | Ops    | Mismatches | Unverifiable features |
| ------ | -------- | ---------------- | ------------- | ------ | ---------- | --------------------- |
| before | 13       | 9                | 26            | 130000 | 0          | 0                     |
| after  | 13       | 1                | 1             | 130000 | 0          | 2                     |

Before the patch, 40 sites were executed and 0 standalone errors occurred. After the patch, 36 sites were executed.

## What the patch does and leaves

`patch/crossslot.patch` changes 7 Sim files, listed in `patch/NOTES.md`, and is applied to a copy of the corpus.
It adds hash tags so the keys of one operation share a slot, and splits multi-key commands and pipelines into
per-key calls. In the realtime room manager it splits two scripts and one transaction in two, so removal and
activity updates are no longer atomic across the room and the socket. Key names change for hosted queue, CLI auth,
room, socket and file document keys, so old keys are orphaned and old and new versions do not share state during a
rolling deploy. `patch/NOTES.md` has the key table and the semantic changes.

What it leaves: the token bucket's multi-bucket script still fails (1 site), because its keys come from callers and a
shared tag has to be agreed there. Two features (outbox cursors, file document reader) have replacement calls under a
condition the harness cannot evaluate. They are reported as unverifiable and never counted as passing. This is a
test of one possible change, not a finished fix for #9734.

## Limitations

- The counts are failing Redis operations, not application crashes. Sim catches several of these errors and fails
  open with warnings, for example the hosted queue stops queueing.
- Zero mismatches does not mean equal behaviour. A failed operation skips the comparison with the standalone result.
- The harness drives Sim's extracted Lua scripts and key builders through the same client libraries (ioredis 5.11.1,
  within Sim's `^5.6.0`, and node-redis 5.10.0, exact). It does not run Sim's whole application.
- The reproductions inject a cluster client into Sim's unchanged methods, because Sim has no cluster option.
- The harness's classifier counts any Redis reply error as a Sim failure before it checks for harness errors. No
  effect was found on these results, but it is a limitation.
- The harness repairs some failed writes with single-key commands so that later sites are exercised. Unrepaired
  failures also suppress later comparisons involving the affected entities. `XREAD` blocking waits are omitted. Timing,
  concurrency and pub/sub compatibility are not established.
- One Redis version (8.10.3), one machine, one pinned Sim commit.

## Test

```
npm test                 unit tests
npm run lint
npm run typecheck
npm run acceptance       black-box tests without the cluster
CROSSSLOT_CLUSTER_TESTS=1 npm run acceptance   needs npm run cluster:up first
```

## Licence

MIT, see `LICENSE`. Sim is Apache-2.0 and is fetched at run time, not redistributed. `patch/` modifies Sim files and
keeps Sim's `LICENSE` and `NOTICE`. See `NOTICE`.
