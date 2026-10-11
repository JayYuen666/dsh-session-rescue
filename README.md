# @jayyuen66/dsh-session-rescue

[中文](./README.zh-CN.md)

### What it does

- It removes the manual chore when a turn ends badly, via three automatic injections: **resume** after a transient failure, **continue** after output truncation, **re-run** after an open todo list.
- There is also a request-level 429 backstop, and it only takes over when the host resolved **no** `retryPolicy` for that provider: it listens on `agent/request-error` (waterfall) and returns `{ kind: "retry" }` on rate limiting so the host re-sends that request inside the same turn.
  - Both chains share one waterfall and the first `{kind:'retry'}` wins, so when a policy exists the official `llm-retry` owns the retry (`retryableCodes` filtering, `providerRetryAfterMs`, jitter, durable `llm/retry` events) and this plugin steps aside. Only the settings card's `default` preset (unset) leaves the ladder as the fallback.
  - The backoff ladder defaults to 2s/5s/10s/20s/30s with at most 5 retries per session (the ladder and the counter are both non-volatile deployment values, see Settings), and the counter resets when the turn closes (`agent/status` → `idle`).
  - A provider `Retry-After` wins over the ladder, and anything above the 30s cap (`requestRetryBackoffCapMs`) is not waited out - the plugin delegates back to `next()`.
- The client half (built artifact `client.js`) docks below the input box:
  - edit-resend (this session) / fork-resend (new branch) / withdraw and edit queued messages / stop-and-re-ask / manual retry and continue-output / a countdown banner / a per-session switch
- The `/state` poll is a **self-scheduling two-tier loop**: 1s while a pending exists (the banner counts down by the second), 5s as a fallback when nothing is pending.
- The next hop is armed only after the current one lands, so an in-flight request neither overlaps with it nor strands the loop.
- It stops with no subscribers or while the tab is hidden, and catches up one tick on return. Subscribers are only notified when the snapshot actually changed.
- The `subscribe`/`getSnapshot` pair handed to `useSyncExternalStore` is made of **module-level stable references**, so a re-render never re-subscribes.
- Inline closures make React re-run the subscribe effect on every render (the shipped React 18.3.1 is `useEffect(bind(...),[subscribe])`): unsubscribe then re-subscribe turns one render into an extra `/state`.
- There is also a settings card and per-platform 429 retry presets.
- Host surface read: `agent/error`, `agent/status`, `agent/request-error`, `agent/disposed` (cleanup).
- Turn facts (`turn/start`, `turn/end`, `user/message`, `tool/call`, `todo/write`) fold incrementally into a `ctx.sessionProjections` unit; every verdict reads the synchronous `stateOf()` watermark.
  - On profiles without that registry, or on shapes the fold cannot vouch for (a `turn/end` whose `turn/start` is outside the window, an evicted opener), it falls back to a full `session.snapshotEvents()` scan with identical verdicts.

### The three automatic actions

- `resume`: `error.failure` on `agent/error` is judged transient by `lib/failure-classify.ts`; the message lands after `resumeDelayMs`.
  - Transient shapes: `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`, HTTP 429, 5xx, `QUOTA` carrying rate-limit wording, `PI_AI_ERROR` carrying an unrecognized `finish_reason` or empty-response wording.
- `continue`: `agent/status` goes to `idle` and the last `turn/end` carries `reason.kind === "max-tokens"`; the "continue from the truncation" message lands after `continueDelayMs`.
- `unfinished`: that same `turn/end` is `completed`, but the `todo/write` snapshot **that turn wrote itself** still holds non-`completed` items (`lib/turn-review.ts`, a purely structured signal, no text guessing); the message lands after `unfinishedDelayMs`.
- Each kind has its own delay / cooldown / quota gates (`lib/resume-scheduler.ts`, cooldowns tracked per kind).
  - Every injection is a `role: "user"` message with `source: { kind: "plugin:session-rescue" }`: the model picks the conversation back up, so tokens and quota keep being spent.

### When it does nothing

- Permanent failures: `CONTEXT_WINDOW_EXCEEDED`/`AUTH`/`INVALID_CREDENTIAL`/`MISSING_CREDENTIAL`/`INVALID_REQUEST`/`INVALID_ARGS`/`NO_ADAPTER`/`INVALID_MODEL_CONTEXT`/`INVALID_PREPARED_CALL`, HTTP 401/403.
  - Exhausted-balance wording (`insufficient quota|balance|credits` and friends) and anything unrecognized; an `error` without `.failure` (a plain Error) counts the same.
  - Classification is built-in safety logic and the card deliberately exposes no way to change it.
- Non-root sessions (sub-agents); `resume` on a provider listed in `providerExcludes` - which does not gate `continue`, `unfinished`, or the request-level 429 retry.
- You stopped it: when the last `turn/end` carries `reason.kind` `aborted` or `interrupted`, nothing is injected and no quota is spent.
- It is waiting for you: the turn called `ask_user_question` → no re-run message; the turn's first `user/message` carries a `source.kind` of `"goal"` (goal-round driven) or `"schedule"` (the official Schedule reminder) → all three kinds stand down.
- The pre-fire check (`preFireCheck`) fails: the agent is gone, the status is not `idle`, the inbox holds queued messages, or a newer turn already started → the pending injection is silently voided, without counting or entering cooldown.
  - The gates block it when that kind already has a pending record, is inside its cooldown, or has spent its quota.
  - Quota is a _consecutive_ notion - one `completed` turn zeroes `resume`/`continue`, while `unfinished` only refills once the list closes.

### Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-session-rescue
```

- Requires dsh `>= 0.2.1-alpha.2`: the source of truth is the `@deepseek-ai/dsh` entry under `peerDependencies` (the host validates it on plugin install from 0.1.7-rc, and it checks the `@deepseek-ai/dsh-*` peers the same way). `engines.dsh` carries the same value but nothing reads it.
- The packages are on the public npm registry, so installation needs no credentials.
- Remove with `dsh plugin --profile web remove @jayyuen66/dsh-session-rescue`. MIT licensed; the source repository is in `repository.url` of `package.json`.

### Enabling it in dsh

- Bundle form: the package's own `cordis.patch.yml` carries `- id: session-rescue` + `name: "@jayyuen66/dsh-session-rescue"` and is pointed at by `dsh.bundle.patch` in `package.json`, so `dsh plugin add` registers it.
  - The published entry points are the `prepack`-rebuilt `host.js` and `client.js`.
- The host half hard-depends on `timer` and `settings` (`inject: ["timer", "settings"]`); `webServer` is required through a child fiber, so a host without webServer (TUI) keeps auto-resume working and simply never gets the six routes.
- The settings card lives in `plugins.bundle.config` on the plugin page, keyed by the bundle package name `@jayyuen66/dsh-session-rescue` (that is the `dsh.profile.bundles` row in `~/.dsh/profiles/web/package.json`).
  - `configForms.get()` and the settings namespace stay the bare entry id `session-rescue`; edits are staged, Save writes them into settings, Revert discards them.
- Without UI, deployment defaults go on the registration line's `config:`; precedence = card runtime value > line `config` > schema `.default()`, and an invalid `config` fails the plugin load loudly.

### Settings

Namespace `session-rescue`: registered implicitly (it IS the entry id in `cordis.patch.yml` — the package does not call `settings.register`). The settings form and the line `config` share one `Config` schema in `host.ts` (single source, drift-proof); built-in defaults sit on each field's `.default()`, and the thirteen `.volatile()` fields are what the card exposes (three further non-volatile deployment values sit at the end of the list below). Times in ms. Ranges: delays 1000-300000 (`continueDelayMs` 500-300000), cooldowns 5000-3600000, counters 0-20.

- Global: `enabled` `true`, `providerExcludes` `[]`.
- `resume`: `resumeDelayMs` `10000`, `resumeCooldownMs` `120000`, `maxResumes` `3`, `chainResumeDelayMs` `60000` (when the turn opened by a resume message fails again, the cooldown is bypassed and it re-schedules at this delay).
- `continue`: `continueDelayMs` `3000`, `continueCooldownMs` `60000`, `maxContinues` `3`.
- `unfinished`: `resumeOnOpenTodos` `true` (this kind's own switch), `unfinishedDelayMs` `5000`, `unfinishedCooldownMs` `120000`, `maxUnfinished` `2`.
- The three deployment values of the request-level 429 retry: not `.volatile()`, so the card has no row for them - they go on the registration line's `config:` only (plain values, so a change applies on restart).
  - Defaults: `requestRetryMax` `5` (0-20), `requestRetryBackoffMs` `[2000, 5000, 10000, 20000, 30000]` (at least one entry), `requestRetryBackoffCapMs` `30000` (min 1000).

### Public surface

- Six `webServer` routes (`kind: "exact"`):
  - `GET /_dsh/session-rescue/state` (per-session counters, remaining pending time, switch state, plus this apply's write token)
  - `POST /_dsh/session-rescue/cancel?sessionId=`
  - `POST /_dsh/session-rescue/toggle?sessionId=` (per-session switch; turning it off also disarms the pending record)
  - `POST /_dsh/session-rescue/resume` (the client signals `connection/reset` so suspended pendings re-arm)
  - The remaining two: `GET /_dsh/session-rescue/retry-providers`, `POST /_dsh/session-rescue/retry-policy`
- Trust gate on writes: all six handlers open with `guardTrust(req, res, { servingNonLoopback })` from `shared/lib/trust`, judged as Host authority -> `sec-fetch-site` allowlist -> verbatim `Origin` comparison.
  - Any failure -> `403` plus JSON `{ ok: false, error: "untrusted host authority" | "cross-origin request rejected" }` (the `isCrossOrigin` leg in `lib/http` becomes unreachable - stricter allowlist, same text); `servingNonLoopback` comes from shared's `isNonLoopbackBindHost(webServer.host)`, because the Host binds a real interface address - the wildcard addresses are rejected when the host loads.
  - Wrong method -> 405 with `Allow` plus `{ ok: false, error: "GET only" }` (the two GET routes) or `"POST only"` (the four POST routes) - no longer an empty body.
- CSRF and size: POSTs must echo in `x-rescue-csrf` the token `state` handed out (missing or wrong -> 403 `invalid csrf token`); the `retry-policy` body is capped at 64 KiB (oversized 413, unreadable stream 400).
- `retry-policy` writes into the official `llm-pi-ai` namespace at `providers.<name>.retryPolicy` (presets `default`/`enhanced`/`always`/`off`, persisted via `settings.mutate`); the package keeps no second retry configuration of its own.
- The only model-visible artifact: one message through `agent.followup()` with `role: "user"`, an `id` like `session-rescue-<timestamp>-<seq>`, and text taken from the fixed bilingual templates in `lib/messages.ts` - no session content is interpolated.
- Optional read of `ctx.get("lessonLoop")`: when present it receives the `transient-failure`, `unclassified-failure`, `max-tokens` and `unfinished-turn` facts, and one `pass` once the same provider genuinely finishes a `completed` turn.
  - An absent or throwing bus only warns, the main path never depends on it.

### Data and privacy

- The host half writes no files and makes no outbound requests (no `node:fs`, no network calls).
  - All runtime state is in memory and bounded: at most 200 session records in the scheduler, 64 suspended pendings and 64 pending pass entries, oldest trimmed first, with timers released on `agent/disposed` and on plugin unload.
- Persistence happens in exactly two places, both through the official settings service: this package's namespace `session-rescue` and the `llm-pi-ai` retry presets, stored under `<dsh data dir>` (`$DSH_HOME`) and surviving restarts.
- The per-session switch lives only in process memory; a restart falls back to the global `enabled`.
- The injected text follows the official locale preference (`value.preference` on the `locale` row of `settings.describe()`) and defaults to Chinese when that entry is not projected.
- Content only leaves towards `lesson-loop` if that plugin is installed: it receives the failure code/status/message verbatim, the session id and the session's `cwd`, and lesson-loop alone decides where that is written. Without it, nothing is recorded.

### FAQ

- Does it silently spend money: yes. The injections are user-role messages, so the model continues and keeps consuming tokens and quota.
- One switch off: the card's "Enable auto-resume" (`enabled = false`) stops all three injections and the request-level 429 retry while keeping the manual UI.
- Narrower exits: the dock's per-session switch, `resumeOnOpenTodos` (re-run only), `providerExcludes` (resume on one provider only).
- Why did it stop without resuming: look for `[session-rescue] <sid>: auto-<kind> skipped (<reason>)` (`pending`/`cooldown`/`max-resumes`) or `vetoed at fire time (<reason>)` in the log; the budget is consecutive-semantics and one finished turn refills it.
- Will it interrupt a question aimed at me: no. Nothing is injected after `ask_user_question`, and goal-round driven turns are skipped by all three kinds.
- The re-run never fires: it requires that turn to have written a `todo/write` list that still holds non-`completed` items - sessions that never use the todo tool structurally cannot trigger it (`openTodos` stays `null`).
- Install fails with 404: that version was never published to npmjs (check `dist-tags.latest`).
  - 404 usually means the sibling library package `@jayyuen66/dsh-plugin-shared` is not on the registry yet - this package value-imports its `lib/locale` and `lib/http`, so a missing one is `ERR_MODULE_NOT_FOUND`.
- What backs these decisions: `test/` covers the four main chains - transient failure resumes, a successful turn refills the quota, an open todo list re-runs, and a waiting-for-user turn stays untouched.
  - `test/integration/loader-boot.test.ts` boots the published artifact through the real cordis loader.
