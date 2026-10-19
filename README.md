# @jayyuen66/dsh-session-rescue

[中文](./README.zh-CN.md)

### What it does

- It removes the manual chore when a turn ends badly, via three automatic injections: **resume** after a transient failure, **continue** after output truncation, **re-run** after an open todo list.
- There is also a request-level 429 backstop, and it only takes over when the host resolved **no** `retryPolicy` for that provider: it listens on `agent/request-error` (waterfall) and returns `{ kind: "retry" }` on rate limiting so the host re-sends that request inside the same turn.
  - Both chains hang on one waterfall, and cordis makes the **first registered** listener the outermost one: whichever runs first can decide without calling `next()`. Official `llm-retry` returns without delegating while its signal is aborted or its entry is disposed (`llm-retry/src/index.ts:163,250`) — in that window this plugin is not consulted at all — and in `always` mode it *adopts* the decision coming back from downstream (`:212`) rather than racing it. When a policy exists the official plugin owns the retry (`retryableCodes` filtering, `providerRetryAfterMs`, jitter, durable `llm/retry` events) and this plugin steps aside. Note the measured host behaviour: the deepseek adapter resolves a policy even when none is configured, so this ladder only ever engages for adapters that resolve none — and a profile without `dsh-llm-retry` mounted leaves a 429 terminal with no request-level retry at all.
  - The backoff ladder defaults to 2s/5s/10s/20s/30s with at most 5 retries per session (the ladder and the counter are both non-volatile deployment values, see Settings), and the counter resets when the turn closes (`agent/status` → `idle`).
  - A provider `Retry-After` wins over the ladder, and anything above the 30s cap (`requestRetryBackoffCapMs`) is not waited out - the plugin delegates back to `next()`.
- The client half (built artifact `client.js`) docks below the input box:
  - edit-resend (this session) / fork-resend (new branch) / stop-and-re-ask / manual retry and continue-output / a countdown banner / a per-session switch
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
- It is waiting for you: the turn called `ask_user_question` → no re-run message. A turn whose first `user/message` carries `source.kind: "schedule"` (the official Schedule reminder) → all three kinds stand down. A `"goal"` turn is not an automatic stand-down: the official `goal-round-driver` only disarms on `agent/error` and never auto-retries, so standing down unconditionally would abandon that round to nobody. Instead the decision is taken at fire time from the driver's own state — `active` + `armed` means it is still driving, so we stand down; `active` + `disarmed` means it gave up, so we take the round over. `paused` / `blocked` / `complete` are human or lifecycle decisions and are never overridden, and if the goal state cannot be read at all we stand down too.
- The pre-fire check (`preFireCheck`) fails: the agent is gone, the status is not `idle`, the inbox holds queued messages, or a newer turn already started → the pending injection is silently voided, without counting or entering cooldown.
  - The gates block it when that kind already has a pending record, is inside its cooldown, or has spent its quota.
  - Quota is a _consecutive_ notion - one `completed` turn zeroes `resume`/`continue`, while `unfinished` only refills once the list closes.

### Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-session-rescue
```

- Requires dsh `^0.2.1-rc.2` (that is, the `0.2.x` line — `^` on a `0.` version caps below `0.3.0`): the source of truth is the `@deepseek-ai/dsh` entry under `peerDependencies` (the host validates it on plugin install from 0.1.7-rc, and it checks the `@deepseek-ai/dsh-*` peers the same way). `engines.dsh` carries the same range but nothing reads it.
- The packages are on the public npm registry, so installation needs no credentials.
- Remove with `dsh plugin --profile web remove @jayyuen66/dsh-session-rescue`. MIT licensed; the source repository is in `repository.url` of `package.json`.


### Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the `@jayyuen66/dsh-plugin-shared` version this package declares. A lower pin installs a copy without the names this package imports at runtime, and the host then reports `N entries did not activate` with `does not provide an export named ...` when it boots -- the package installs fine and never loads, and no per-repo CI run can see it.

### Enabling it in dsh

- Bundle form: the package's own `cordis.patch.yml` carries `- id: session-rescue` + `name: "@jayyuen66/dsh-session-rescue"` and is pointed at by `dsh.bundle.patch` in `package.json`, so `dsh plugin add` registers it.
  - The published entry points are the `prepack`-rebuilt `host.js` and `client.js`.
- The host half hard-depends on `timer` and `settings` (`inject: ["timer", "settings"]`); the client read surface is the official Typert Remote service `sessionRescue`, registered into the host `remote` gateway through an injected child fiber. It does not depend on `webServer`, so a host without that service (TUI) keeps auto-resume working and only loses the settings card data plane.
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

- Six methods on the official Typert Remote namespace `sessionRescue`: `state`, `cancel({ sessionId })`, `toggle({ sessionId })`, `resume`, `retryProviders`, `retryPolicy({ provider, preset })`. Parameters go through strict codecs; results use `src-json`.
  - Authentication and transport boundaries are enforced by the host `/api` gateway (Host/DNS-rebinding/Origin checks, signed browser-session cookie, body limits); the package no longer opens raw HTTP routes and keeps no CSRF token of its own.
- When the read surface is unreachable the dock degrades instead of pretending — after three consecutive unreadable polls it discards the cached snapshot (the countdown banner and the per-session switch fall back to their neutral state rather than counting down from a value nobody confirmed) and polling backs off by doubling up to a 30 s ceiling, while the turn-relative actions stay available because they read live session state rather than the read surface.
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
- Will it interrupt a question aimed at me: no. Nothing is injected after `ask_user_question`. A goal round is only taken over once the official driver has disarmed for it — while the goal is still `armed`, or when it is `paused`/`blocked`/`complete`, this plugin stays out.
- The re-run never fires: it requires that turn to have written a `todo/write` list that still holds non-`completed` items - sessions that never use the todo tool structurally cannot trigger it (`openTodos` stays `null`).
- Install fails with 404: that version was never published to npmjs (check `dist-tags.latest`).
  - 404 usually means the sibling library package `@jayyuen66/dsh-plugin-shared` is not on the registry yet - this package value-imports its `lib/locale`, `lib/record`, `lib/errors`, `lib/card-apply`, `lib/card-diff` and `lib/lesson-bus`, so a missing one is `ERR_MODULE_NOT_FOUND`.
- What backs these decisions: `test/` covers the four main chains - transient failure resumes, a successful turn refills the quota, an open todo list re-runs, and a waiting-for-user turn stays untouched.
  - `test/integration/loader-boot.test.ts` boots the published artifact through the real cordis loader.
