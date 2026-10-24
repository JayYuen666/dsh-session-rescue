<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-session-rescue@main/icon.svg" width="96" height="96" alt="dsh-session-rescue logo" />
</p>

<h1 align="center">dsh-session-rescue</h1>

<p align="center"><em>When a turn ends badly, the session picks itself back up: auto-resume after transient failures, auto-continue after truncation, catch-up for open todo lists — plus manual rescue actions below the input box.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-session-rescue"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-session-rescue?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-session-rescue"><img src="https://img.shields.io/npm/dm/@jayyuen66/dsh-session-rescue?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/JayYuen666/dsh-session-rescue/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-session-rescue/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/lang-简体中文-658EFF?style=flat-square" alt="简体中文" /></a>
</p>

**A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin: three automatic user-role injections when a turn ends badly (transient failure / max-tokens truncation / an open todo list), a request-level 429 backstop, and a client dock with manual rescue actions and a settings card. Zero model tools, zero HTTP routes of its own.**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Contents

- [What it does](#what-it-does)
  - [How a decision is made](#how-a-decision-is-made)
- [Install](#install)
  - [Shared version floor](#shared-version-floor)
- [Verify it is live](#verify-it-is-live)
- [What it does not provide](#what-it-does-not-provide)
- [Enabling it in dsh](#enabling-it-in-dsh)
- [The three automatic actions](#the-three-automatic-actions)
- [Settings](#settings)
- [Public interface](#public-interface)
- [Data and privacy](#data-and-privacy)
- [Known boundaries](#known-boundaries)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

- **Three automatic injections when a turn ends badly**, each with its own delay / cooldown / quota gates (`lib/resume-scheduler.ts`, cooldowns tracked per kind):
  - **resume** — `agent/error` whose failure `classifyFailure` (`lib/failure-classify.ts`) judges transient; the message lands after `resumeDelayMs`.
  - **continue** — the turn ended with `reason.kind === "max-tokens"`; "continue from the truncation" lands after `continueDelayMs`.
  - **unfinished** — the turn ended `completed`, but the todo list **that turn itself wrote** still holds open items (`lib/turn-review.ts`, a purely structural signal, no text guessing); the catch-up message lands after `unfinishedDelayMs`.
  - Every injection is a `role: "user"` message with `source: { kind: "plugin:session-rescue" }` sent through `agent.followup()` — the model keeps running, so tokens and quota keep being spent.
- **A request-level 429 backstop**, engaged only when the host resolved **no** `retryPolicy` for that provider: it listens on `agent/request-error` (waterfall) and returns `{ kind: "retry" }` on rate limiting, so the host re-sends that request inside the same turn.
  - Fixed backoff ladder (defaults 2 s / 5 s / 10 s / 20 s / 30 s, at most 5 retries per session — deployment values); a provider `Retry-After` wins over the ladder, and anything above the cap is not waited out but delegated back to `next()`. The counter resets when the turn closes.
  - When a policy exists the official `llm-retry` owns the retry (code filtering, provider retry-after, jitter, durable events). The deepseek adapter resolves a policy even when none is configured, so this ladder only ever engages for adapters that resolve none.
- **A client dock below the input box**: edit-resend (this session) / fork-resend (new branch) / stop-and-reask / manual retry and continue-output / a countdown banner / a per-session switch. Stop-and-reask queues your re-ask first and then cancels, so the message survives the cancel; the manual retry stays disabled while the host's built-in retry is still in progress.
- **Connection-aware**: an injection whose send failed (transport trouble) is suspended instead of dropped, shown as a reconnecting banner, and re-armed with its remaining delay once the connection returns.
- **`/state` polling is a self-scheduling two-tier loop**: 1 s while a pending exists (the banner counts down by the second), 5 s otherwise; the next hop is armed only after the current one lands, so an in-flight request neither overlaps nor strands the loop. After three consecutive unreadable polls the cached snapshot is discarded — the banner and the per-session switch fall back to their neutral state instead of counting down from a value nobody confirmed — and polling backs off by doubling up to 30 s.
- **A settings card** with the rescue knobs and per-provider 429 retry presets written into the official `llm-pi-ai` namespace.
- Host read surface: `agent/error`, `agent/status`, `agent/request-error`, `agent/disposed` (cleanup). Turn facts (`turn/start`, `turn/end`, `user/message`, `tool/call`, `todo/write`) fold incrementally through `ctx.sessionProjections`; on profiles without that registry, or on shapes the fold cannot vouch for, it falls back to a full `session.snapshotEvents()` scan with identical verdicts.

### How a decision is made

- Classification (`classifyFailure`) is a fixed ladder. Permanent failure codes veto first (`CONTEXT_WINDOW_EXCEEDED` / `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` / `INVALID_REQUEST` / `INVALID_ARGS` / `NO_ADAPTER` / `INVALID_MODEL_CONTEXT` / `INVALID_PREPARED_CALL`). The `QUOTA` code is then split by evidence: HTTP 429, `Retry-After` or rate-limit wording means transient; balance-exhausted wording means permanent. HTTP 401/403 and billing status 402 are permanent; the explicit transient codes (`RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE`), HTTP 408/425/429/5xx and rate-limit wording are transient; `PI_AI_ERROR` with an unrecognized `finish_reason` or empty-response wording is transient. Everything unrecognized is permanent — conservative by design.
  - An `error` without a `.failure` face counts the same as permanent; the classifier unwraps host-wrapped `AggregateError` before giving up.
  - Classification is built-in safety logic; the card deliberately exposes no way to change it.
- **Standing down:** non-root (subagent) sessions; `providerExcludes` hits `resume` only; the last `turn/end` says `aborted` or `interrupted` (you stopped it — nothing is injected, no quota spent); the turn called `ask_user_question` (no catch-up); the turn was opened by the official Schedule reminder (all three kinds stand down).
  - A `"goal"` turn is decided **at fire time** from the official goal service, not unconditionally: `active` + `armed` (the driver is still driving) → stand down; `active` + `disarmed` (the driver gave up — by its own design it never auto-retries) → this plugin takes the round over; `paused` / `blocked` / `complete` are human or lifecycle decisions and are never overridden; an unreadable goal state stands down too.
- **Pre-fire check** (`preFireCheck`): the agent is gone, the status is not `idle`, the inbox holds queued messages, or a newer turn already started → the pending injection is silently voided, without counting or entering cooldown.
- **Quota is consecutive**: one `completed` turn zeroes `resume` / `continue`; `unfinished` only refills once the todo list closes (otherwise inject → still open → inject again would self-oscillate).

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-session-rescue
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-session-rescue`. The package is on the public npm registry, so installation needs no credentials and no scoped-registry line.

- **Requires Node.js `>= 22.12`.** This is an ESM-only package; that Node floor is what makes `require()` of an ESM entry work at all, which is why `engines.node` is declared.
- **Requires host `dsh` at the `0.2.1-rc.3` line.** The requirement the host validates at install time is the `@deepseek-ai/dsh` entry under `peerDependencies` (`^0.2.1-rc.3`, i.e. the `0.2.x` line — `^` on a `0.` version caps below `0.3.0`); the `@deepseek-ai/dsh-*` peers are checked the same way, and `engines.dsh` carries the same range.
- **No `@deepseek-ai/*` under `dependencies`, by contract** (`test/publish-manifest.test.ts` enforces it). Consumer profiles install with `nodeLinker: hoisted` and `autoInstallPeers: false`, so a host package under `dependencies` is materialized as a real directory next to the copy the running host already loaded — native tool calls then throw while build, typecheck and coverage stay green. The host packages `host.js` imports for value (`@deepseek-ai/dsh-brand`, `@deepseek-ai/schemastery`) are required peers repeated under `devDependencies` at the same pin, so the bundler externalizes them instead of inlining official function bodies.
- **What ships**: the `prepack`-rebuilt `host.js` and `client.js`, `types/`, `cordis.patch.yml`, plus `README*`, `LICENSE`, `CHANGELOG.md` and `icon.svg`. Artifacts are not committed, and are not minified on purpose — the bare cross-package specifiers must survive for the externalization assertions to mean anything.
- Install fails with 404: that version was never published (check `dist-tags.latest`). It usually means the sibling library package `@jayyuen66/dsh-plugin-shared` is not on the registry yet — this package value-imports its `lib/locale`, `lib/record`, `lib/errors`, `lib/card-apply`, `lib/card-diff` and `lib/lesson-bus`, so a missing one surfaces as `ERR_MODULE_NOT_FOUND`.

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the version this package declares. A lower pin installs a copy without the names imported at runtime, and the host then reports `N entries did not activate` together with `does not provide an export named ...` at boot — the package installs fine and never loads, and no per-repository CI run can see it.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is live

1. **Mounted**: `dsh --profile web --dump-config` shows this package's layer.
   - That command is the only accepted "it is in the layer stack" signal, and it is **not read-only** — it rewrites the profile's root assembly file. Read layer lines from stdout **and** check stderr separately: an unmatched patch target appears only on stderr, so the exit code alone proves nothing.
   - A layer line may read `# == <layer>` or `# == <layer>, patched by <path>`; accept both forms.
2. **The dock renders**: with a session open, the rescue dock sits below the input box — the per-session switch row, stop-and-reask while a turn is running, and the edit-resend / retry / continue actions on a completed or failed turn.
3. **The settings card renders live data**: the plugin page lists the session-rescue card, and its 429 preset section loads your `llm-pi-ai` providers (name, retry mode, quota coverage). A permanently "unavailable" readout means the layer is mounted but the Remote namespace did not reach the browser.
4. **A live rescue**: make the model call fail transiently mid-turn (for example by cutting the network); the banner appears and counts down by the second, and the log carries `[session-rescue]` lines naming the kind and the gate. Counter-check: a turn you stop yourself (`aborted`) injects nothing, by design — "no injection" there is not a broken install.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

- **It registers no model tools.** The surface is host events plus the Remote namespace; there is no `session_rescue` tool for the model to call.
- **It opens no HTTP route of its own.** The data plane is the official Typert Remote namespace `sessionRescue`, reached through the host `/api` gateway; authentication, Host / DNS-rebinding / Origin checks and body limits are all the gateway's.
- **It adds no CLI subcommand.**
- **It renders no queued-message UI of its own**: the official conversation package already docks the queue with per-item edit / delete / interject, and this package does not duplicate it.
- **The host half writes no file and makes no outbound request** (see Data and privacy).
- What it *does* consume optionally: the `lessonLoop` bus (facts and passes), `sessionProjections` (fast turn facts) and the goal service (fire-time takeover verdict). A profile without them keeps rescuing — it just falls back to the full log scan, and goal turns are left alone.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- Bundle form: `dsh.bundle.patch` in `package.json` points at `cordis.patch.yml`, whose single line is `- id: session-rescue` with `name` set to the bare package name — the host scans `dsh.client` on bare-name entries only. `dsh plugin add/remove` maintains the assembly layer.
- The host half hard-depends on `timer` and `settings` (`inject: ["timer", "settings"]`); the read surface is registered through an injected child fiber into the host `remote` gateway. It does not depend on `webServer`, so a host without that service (TUI) keeps auto-rescue working and only loses the settings card's data plane.
- The settings card lives in `plugins.bundle.config` on the plugin page, keyed by the **bundle package name**; `configForms.get()` and the settings namespace stay the bare entry id `session-rescue`. Edits are staged, Save writes them into settings, Revert discards.
- Without UI, deployment defaults go on the registration line's `config:`; precedence = card runtime value > line `config` > schema `.default()`, and an invalid `config` fails the plugin load loudly.

## <img src="https://api.iconify.design/lucide/refresh-cw.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The three automatic actions

| Kind | Trigger | Default delay / cooldown / quota |
|---|---|---|
| `resume` | `agent/error`, failure classified transient (`lib/failure-classify.ts`) | 10 s / 120 s / 3 |
| `continue` | Turn ended `max-tokens` (output truncated) | 3 s / 60 s / 3 |
| `unfinished` | Turn ended `completed`, its own todo list still open (`lib/turn-review.ts`) | 5 s / 120 s / 2 |

- `resumeOnOpenTodos` is the catch-up kind's own switch; `providerExcludes` gates `resume` only and touches neither of the other kinds nor the request-level 429 retry.
- A resume-opened turn that fails again transiently **bypasses the cooldown** and re-schedules at `chainResumeDelayMs` (default 60 s): `resumeDelayMs` plus failure time always sits inside the 120 s cooldown, so without this exception a failing chain would be silently swallowed.
- The injected text comes from the fixed bilingual templates in `lib/messages.ts` and follows the official locale preference (Chinese when that entry is not projected); no session content is interpolated.

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

Namespace `session-rescue` = the entry id (implicit registration — the package does not call `settings.register`). The settings form and the line `config` share one `Config` schema in the host entry; the `.volatile()` fields are the card's editable face. Times in ms.

| Field | Type / range | Default | Card | Purpose |
|---|---|---|---|---|
| `enabled` | boolean | `true` | yes | Master switch; `false` stops all three injections and the request-level 429 retry, the manual dock stays |
| `providerExcludes` | string[] | `[]` | yes | Providers whose `resume` never auto-fires (e.g. ones with a dedicated retry policy) |
| `resumeDelayMs` | 1000–300000 | `10000` | yes | Wait after a transient failure |
| `resumeCooldownMs` | 5000–3600000 | `120000` | yes | Minimum interval between two resumes in one session |
| `maxResumes` | 0–20 | `3` | yes | Per-session resume quota (consecutive semantics) |
| `chainResumeDelayMs` | 1000–300000 | `60000` | yes | Re-schedule delay when a resume-opened turn fails again (cooldown bypassed) |
| `continueDelayMs` | 500–300000 | `3000` | yes | Wait after a max-tokens truncation |
| `continueCooldownMs` | 5000–3600000 | `60000` | yes | Minimum interval between two continues |
| `maxContinues` | 0–20 | `3` | yes | Per-session continue quota |
| `resumeOnOpenTodos` | boolean | `true` | yes | The catch-up kind's own switch |
| `unfinishedDelayMs` | 1000–300000 | `5000` | yes | Wait after an open-todo turn |
| `unfinishedCooldownMs` | 5000–3600000 | `120000` | yes | Minimum interval between two catch-ups |
| `maxUnfinished` | 0–20 | `2` | yes | Catch-up quota; refills only when the list closes |
| `requestRetryMax` | 0–20 | `5` | no | Request-level 429 retry cap |
| `requestRetryBackoffMs` | number[] (≥ 1 entry) | `[2000, 5000, 10000, 20000, 30000]` | no | Backoff ladder for the request-level retry |
| `requestRetryBackoffCapMs` | ≥ 1000 | `30000` | no | Longest this plugin will wait; a longer `Retry-After` delegates back downstream |

The three `requestRetry*` rows are deployment values: not `.volatile()`, so the card has no row for them — they go on the registration line's `config:` only (plain values, applied on restart).

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Public interface

Six methods on the official Typert Remote namespace `sessionRescue`. Parameters go through strict codecs; results use `src-json`.

| Method | Input | Reply |
|---|---|---|
| `state` | — | `ok` plus a per-session snapshot: pending kind, remaining-ms countdown, chained / suspended flags, fire counters, the per-session switch |
| `cancel` | `{ sessionId }` | Cancels that session's pending injection, suspended ones included |
| `toggle` | `{ sessionId }` | Flips the per-session switch; switching off also cancels pendings. 409 when the toggle ledger is full with no dead session to evict |
| `resume` | — | Restores suspended injections after a reconnect; `ok` plus the restored count |
| `retryProviders` | — | The official `llm-pi-ai` providers with retry mode / count / quota coverage; 503 when that namespace is unavailable |
| `retryPolicy` | `{ provider, preset }` | Writes `providers.<name>.retryPolicy` (presets `default` / `enhanced` / `always` / `off`) via `settings.mutate`; a revision conflict answers 409 |

- A refusal's `status` is a retained semantic code, not an HTTP status of a route of this package — there are no routes.
- The only model-visible artifact: one `role: "user"` message through `agent.followup()`, with an id like `session-rescue-<timestamp>-<seq>` and text from the fixed templates. This package keeps no second retry configuration of its own.
- Optional `lessonLoop` bus: when present it receives the `transient-failure`, `unclassified-failure`, `max-tokens` and `unfinished-turn` facts, and one `pass` once the same provider genuinely finishes a `completed` turn. An absent or throwing bus only warns; the main path never depends on it.

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

| Aspect | Content |
|---|---|
| Nothing written, nothing fetched | The host half uses no `node:fs` and makes no network calls; the only output surfaces are `console.*` lines and the injected message |
| In memory, bounded | At most 200 session records in the scheduler, 64 suspended pendings, 64 pending-pass entries and 200 per-session toggle entries — oldest trimmed first, timers released on `agent/disposed` and on plugin unload |
| Persisted, exactly two places, both through official settings | This namespace `session-rescue` and the `llm-pi-ai` retry presets, stored under the dsh data directory and surviving restarts |
| Per-session switch | Process memory only; a restart falls back to the global `enabled` |
| Language | The injected text follows the official locale preference; Chinese when that entry is not projected |
| The only exit path | Content leaves only towards lesson-loop, and only when it is installed: it receives the failure code / status / message verbatim, the session id and the session's `cwd`, and lesson-loop alone decides where that is written. Without it nothing is recorded |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Known boundaries

- **Unknown failure shapes are permanent, by design.** Everything the classifier cannot recognize is left alone; the card exposes no override. A mis-guessed "transient" would re-open turns that can never succeed.
- **`providerExcludes` gates `resume` only** — `continue`, `unfinished` and the request-level 429 retry do not consult it.
- **Subagent sessions are never touched** — only root sessions are rescued.
- **The catch-up kind has a structural precondition**: the turn must have written a `todo/write` list that still holds `pending` or `in_progress` items. Sessions that never use the todo tool cannot trigger it.
- **The 429 ladder only engages for providers that resolve no `retryPolicy`**, and the deepseek adapter resolves one even unconfigured. A profile without `dsh-llm-retry` mounted leaves a 429 terminal with zero request-level retries.
- **The official `llm-retry` is not always downstream**: while its abort signal is fired or its entry is disposed it returns without delegating, and in `always` mode it adopts the decision coming back — this plugin is simply not consulted in those windows.
- **While the read surface stays unreachable the dock degrades instead of pretending**: the banner and the per-session switch fall back to neutral and polling backs off. The turn-relative actions keep working — they read live session state, not the read surface.

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question | Answer |
|---|---|
| Does it silently spend money? | Yes. The injections are user-role messages, so the model continues and keeps consuming tokens and quota. |
| I want one switch off. | The card's master switch (`enabled = false`) stops all three injections and the request-level 429 retry while keeping the manual UI. |
| Narrower exits? | The dock's per-session switch, `resumeOnOpenTodos` (catch-up only), `providerExcludes` (resume on one provider only). |
| The model stopped but nothing resumed. | Look for `[session-rescue] <sid>: auto-<kind> skipped (pending/cooldown/max-resumes)` or `vetoed at fire time (<reason>)` in the log. Quota is consecutive — one finished turn refills it. |
| Will it interrupt a question aimed at me? | No. Nothing is injected after `ask_user_question`, and a goal round is only taken over once the official driver has disarmed for it. |
| The catch-up never fires. | It requires that turn to have written a todo list that still holds open items — sessions that never use the todo tool structurally cannot trigger it. |
| The banner counts down but nothing happens. | The pre-fire check voided it (agent gone, status not idle, queued inbox messages, or a newer turn) — check the `vetoed at fire time` log line. |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check   # typecheck → lint → client build → host build → types → tests → integration → property → format
```

- Unit tests (hand-written host stubs) drive the pure chains: failure classification, scheduler gates, turn-facts fold, dock payload parse.
- `test/integration/` drives the real thing: the published artifact booted through the real cordis loader; a real AgentLoop with the official testkit; a real goal round with the official `goal-round-driver` and a scripted failing mock LLM; abort semantics (a turn you stopped consumes no quota).
- `test/property/` (fast-check) covers the classification order, the turn-facts fold, the `/state` payload parse, and the scheduler's state-machine invariants under random command sequences — each property carries a reach guard, so a criterion that was never exercised turns red instead of green.
- Coverage thresholds are 100% across four metrics, so a new branch needs a case that reaches it.
- `test/publish-manifest.test.ts` guards the published shape: entry targets shipped, no source entry, no `@deepseek-ai/*` under `dependencies`, `dsh-*` peers pinned exactly with `engines.dsh` on the same range, and no dates or machine paths in comments or docs. `test/dist-size.test.ts` holds a size budget over the artifacts.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT. Source at [github.com/JayYuen666/dsh-session-rescue](https://github.com/JayYuen666/dsh-session-rescue). Issues go to that repository's tracker.
