# Patch notes

`crossslot.patch` modifies files of Sim (simstudioai/sim, Apache-2.0) at the commit pinned in
`data/MANIFEST.sha256`. Sim's `LICENSE` and `NOTICE` ship next to it in this folder. The patch is a
derivative work of those files and changes only what is listed here.

Fix classes: T adds a hash tag so the keys one operation touches share a slot. D declares keys a
script touches. S splits a multi-key command or pipeline into per-key commands. R redesigns the
operation because its keys cannot share a tag.

## Changed files

| File | Class | What changes |
|---|---|---|
| `apps/sim/lib/core/rate-limiter/hosted-key/queue.ts` | T | List, heartbeat keys and the heartbeat prefix handed to `CHECK_HEAD_SCRIPT` carry the `{provider:actor}` tag. The script still builds `ARGV[1] .. head` inside, which is now colocated by construction (the scanner reports `info`). |
| `apps/sim/lib/cli-auth/approval-store.ts` | T | Approval and mint-lock keys share the `{hash}` tag, so the two-key `del` in `completeApproval` is one slot. |
| `apps/realtime/src/rooms/redis-manager.ts` | R | Room keys are tagged by room id, socket keys by socket id. `REMOVE_ROOM_SCRIPT` and `UPDATE_ACTIVITY_SCRIPT` are split into a room half and a socket half, and `addUserToRoom` runs two transactions. `deleteRoom` needs no code change (T). |
| `apps/realtime/src/handlers/file-doc-store.ts` | T, S | Every key of one document carries the `{name}` tag (T). The reader issues one `xRead` per document stream instead of one over a batch (S, the multi-document read of `runReader`). |
| `apps/sim/lib/billing/core/usage-segment-cache.ts` | S | `mget(...keys)` becomes one `get` per key, and the write pipeline becomes one `set` per key. Key names are unchanged. |
| `apps/sim/lib/core/outbox/retention.ts` | S | `mget` of the cursors becomes one `get` per type, and the cursor pipeline becomes one `set` or `del` per type. Key names are unchanged. |
| `apps/sim/lib/mothership/request/session/abort.ts` | S | `mget(keys)` of the chat stream locks becomes one `get` per key. Key names are unchanged. |

## Key names that change, and their lifetime

Changing a key name orphans the old one. A long-lived old key is never read again and must be removed by
hand. During a rolling deploy, pods on the old and new version use different keys and do not see each
other's state.

| Old key | New key | TTL | Long-lived |
|---|---|---|---|
| `hosted-queue:<provider>:<actor>` | `hosted-queue:{<provider>:<actor>}` | 600 s, renewed by the head's heartbeat | no |
| `hosted-queue-tkt:<provider>:<actor>:<ticket>` | `hosted-queue-tkt:{<provider>:<actor>}:<ticket>` | 30 s | no |
| `cli:auth:req:<hash>` | `cli:auth:{<hash>}:req` | 120 s | no |
| `cli:auth:mint:<hash>` | `cli:auth:{<hash>}:mint` | 120 s | no |
| `<type>:<id>:users` | `<type>:{<id>}:users` | none, deleted when the room empties | yes |
| `<type>:<id>:meta` | `<type>:{<id>}:meta` | none, deleted when the room empties | yes |
| `socket:<sid>:rooms` | `socket:{<sid>}:rooms` | 24 h, refreshed on activity | yes |
| `socket:<sid>:session` | `socket:{<sid>}:session` | 24 h, refreshed on activity | yes |
| `filedoc:stream:<name>` | `filedoc:stream:{<name>}` | 600 s, refreshed by the heartbeat | no |
| `filedoc:generation:<name>` | `filedoc:generation:{<name>}` | 600 s | no |
| `filedoc:syncver:<name>` | `filedoc:syncver:{<name>}` | 600 s | no |
| `filedoc:invalidatedver:<name>` | `filedoc:invalidatedver:{<name>}` | 600 s | no |
| `filedoc:updates:<name>` | `filedoc:updates:{<name>}` | 600 s | no |
| `filedoc:agentstream:<name>` | `filedoc:agentstream:{<name>}` | short, set per agent frame | no |

Not changed: the usage segment, outbox cursor and chat stream lock keys (S fixes), the seed, compact,
persist and merge lock keys of the file documents (single key each), and every key of the controls.

Room and socket keys with no TTL (`<type>:<id>:users`, `<type>:<id>:meta`) keep living under their
old names after the change if a room was never emptied. Remove them with a one-off scan after the
rollout.

## Semantics that change

- `redis-manager.ts` (R). Removal and activity are no longer atomic across the room and the socket.
  Removal runs the room half first. A crash between the halves leaves the socket's room-set pointing
  at a room whose roster no longer lists it, until the 24 h TTL, and the shared session key is not
  deleted. No other user sees a ghost, which is why the room half goes first. Activity refreshes the
  socket TTLs only when the roster update reports presence, as before, but in a second round trip. A
  crash between `addUserToRoom`'s two transactions leaves the socket listed in the roster without a
  room-set entry. The 24 h TTL does not apply to the roster, so the stale-presence sweep must remove it.
  Sequential operation sequences give the same results as the original on a single node.
- `file-doc-store.ts` (S). The reader used to read up to four streams per call and block on one batch
  at a time, cycling through the batches. It now reads each stream with its own `xRead` and blocks on
  one stream at a time, cycling through the streams. The non-blocking pass still visits every stream
  each loop, so an update reaches a task after one pass plus, at worst, the blocking wait on the stream
  it is parked on, up to `READ_BLOCK_MS`. The cost is one round trip per open document per pass instead
  of one per four. It keeps one blocking connection per reader.
- `usage-segment-cache.ts`, `retention.ts`, `abort.ts` (S). One round trip per key, in parallel, where
  there was one `MGET` or one pipeline. Nothing needed atomicity. The `try` and `catch` fallbacks to the
  database are unchanged.

## Not fixed

UNFIXED: token-bucket CROSSSLOT the atomic multi-bucket consume takes cooldown and bucket keys named by its caller, so one tag must be agreed with the callers first

`consumeTokensAtomically` in `redis-token-bucket.ts` reads and writes cooldown keys and several bucket
keys in one script. The keys are `<credential>:cooldown`, `<credential>:quota` and the bucket names
built in `provider-admission.ts`. A tag derived from the credential would fit them, but it has to be
applied in the caller as well, which this patch does not do. The single-key sites
of the same file work on a cluster and are not changed.
