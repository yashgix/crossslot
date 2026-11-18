# Three failures of Sim on Redis Cluster

Each script runs code from Sim (`simstudioai/sim`, commit `edf5f0a47da8147466cb893c0a1666058331d42e`, vendored unmodified in `data/sim/`) against a standalone Redis and a 6-node Redis Cluster, and prints both outcomes. Standalone succeeds in all three. Related issue: simstudioai/sim#9734.

Sim does not support cluster mode today (issue #9734). These scripts call Sim's unchanged methods with a cluster client injected in place of the standalone client Sim builds, to show what then breaks. The precise requirement is that all keys of one command, script or transaction share a hash slot, for example through a common hash tag. Each script prints one PASS or FAIL line per case and exits nonzero if any outcome is not the expected one, or if setup fails.

Setup from a fresh checkout. Needs Node 22.13 or later and Docker with Compose. `data/sim/` is git-ignored, so fetch the pinned corpus first (this is the root README's "Reproduce everything" section):

```
npm ci --ignore-scripts
npm run build
node dist/cli.js corpus fetch --out data/sim --manifest data/MANIFEST.sha256
(cd data/sim && shasum -a 256 -c ../MANIFEST.sha256)
npm run cluster:up
npm run repro
```

`npm run repro` runs all three. Run one with the command in its section. Stop the Redis containers afterwards with `npm run cluster:down`.

## 1. Token bucket (`npm run repro:token-bucket`)

Sim's `RedisTokenBucket.consumeTokensAtomically` (`apps/sim/lib/core/rate-limiter/storage/redis-token-bucket.ts:166`) admits one provider request with a single `EVAL` over four keys. The keys come from `provider-admission.ts`: `providerKey` (line 199) forms `provider:embedding:openai:<fingerprint>`, then lines 111, 121 and 152 add `:tokens`, `:requests`, `:cooldown` and `:quota`, and the class prefixes `ratelimit:tb:` (line 175). The script runs Sim's real class with no stubs. Expected output: `PASS` for standalone (`allowed {"allowed":true,"retryAfterMs":0}`) and `PASS` for the cluster case, which reports `ReplyError: CROSSSLOT Keys in request don't hash to the same slot`. The four keys have no common hash tag, so they hash on their full text to slots 7116, 6932, 5831 and 12957. A single `EVAL` can only touch keys of one slot, so the server refuses it. Here the first three share a primary and the fourth is on another, and the refusal is the same either way.

## 2. Hosted-key queue (`npm run repro:hosted-queue`)

Sim's `HostedKeyQueue` (`apps/sim/lib/core/rate-limiter/hosted-key/queue.ts`) keeps a FIFO list `hosted-queue:<provider>:<actor>` plus one heartbeat key `hosted-queue-tkt:<provider>:<actor>:<ticket>` per waiter (lines 24-28). `enqueue` (:98), `refreshHeartbeat` (:166) and `dequeue` (:188) each send a `MULTI` that mixes the list key and a heartbeat key, and `checkHead` (:138) runs a Lua script that reads the heartbeat key without declaring it. The script runs Sim's real module, with `@sim/logger`, `@sim/utils/errors` and `@/lib/core/config/redis` stubbed (the last returns the test client from `getRedisClient`). The stubs never touch Redis. Expected cluster output, via Sim's own warn logs: `All keys in the pipeline should belong to the same slots allocation group` for `enqueue`, `refreshHeartbeat` and `dequeue`, and `ERR Script attempted to access a non local key in a cluster node script` for `checkHead`. The list key is in slot 485 (node 7001), the two heartbeat keys in 8077 (7002) and 15037 (7003), so no multi-key call can be served by one node. Sim catches every one of these errors and fails open with warnings: `enqueue` returns `enabled:false` and `checkHead` returns `"head"`, so on a cluster the queue stops queueing. The `checkHead` case is a separately seeded reproduction, not a successful cluster enqueue flow: `enqueue` cannot add the head on a cluster, so the script pushes it with one single-key `RPUSH` so `checkHead` has a list to read.

## 3. Realtime rooms (`npm run repro:realtime-rooms`)

Sim's realtime server (`apps/realtime/src/rooms/redis-manager.ts`, node-redis 5.10.0) stores a socket in a room with keys `workflow:<id>:users`, `workflow:<id>:meta`, `socket:<sid>:rooms` and `socket:<sid>:session` (lines 26-29). `removeUserFromRoom` (:281) runs `EVALSHA` over all four, `updateUserActivity` (:404) over three, `deleteRoom` (:385) runs `DEL` over two, and `addUserToRoom` (:243) runs a `MULTI` over all four. The script runs Sim's real module with `@sim/logger`, `@sim/realtime-protocol/rooms` and `@/rooms/presence-visibility` stubbed (broadcast helpers that are never called). Expected cluster output: `CROSSSLOT Keys in request don't hash to the same slot` for `updateUserActivity`, `removeUserFromRoom` and `deleteRoom`, which are server refusals, and `MOVED 6864 127.0.0.1:7002` for `addUserToRoom`. Slots: users 4318, meta 4548, rooms 3140 (all on 7001), session 6864 (on 7002). `MOVED` is a real failure of Sim's code too, not an artefact: node-redis sends the whole `MULTI` to the node that owns the first key's slot, so the `session` key, owned by another node, is answered with `MOVED`, and a redirect cannot be followed inside a transaction. Which error you see (`MOVED` or `CROSSSLOT`) depends on whether the keys' slots live on one node. Either way the transaction works only if its keys share a slot. The `CROSSSLOT` cases are the cleaner evidence. The manager builds its own client in its constructor with `createClient`, and Sim has no cluster option, so for the cluster run the script sets the manager's private `redis` field to a `createCluster()` client. No Sim code is changed.

## Checks

- The pinned source is hash-checked against `data/MANIFEST.sha256` (all files OK) before and after. The scripts change nothing under `data/`, `src/`, `acceptance/` or `patch/`.
- Each script ran three times against Redis 8.10.3 (ioredis 5.11.1, node-redis 5.10.0) with the same results every time. Outputs of a fresh run are in `results/repro/`.
- Key formats are re-read from Sim's source when a script starts, and it stops if Sim no longer builds them that way. Slots and owners are asked from the cluster (`CLUSTER KEYSLOT`, `CLUSTER SLOTS`), not computed here.
- Run flags: `--experimental-transform-types` (Sim's class uses a constructor parameter property, which type stripping alone cannot load) and `--import ./repro/register.ts`, a module-resolution hook that maps Sim's `@/` alias and the stubs. `repro/` is outside `tsconfig.json` (which includes only `src` and `test`), so no tsconfig change was needed.
