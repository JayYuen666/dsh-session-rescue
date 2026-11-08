# Session rescue

Rescues a stalled turn: it re-sends after a transient provider failure, continues an output that was cut short, and runs on until unclosed todos are actually closed.

## What the card changes

Three independent automatic actions, each with its own wait, per-session cooldown and quota. Delays are entered in seconds and stored in milliseconds.

- **Master switch** — `enabled` (on); with it off all three automatic actions and the request-level 429 retry stop, leaving only the manual entries (stop-and-reask, edit-resend, retry, send-continue, and resume-interrupted).
- **Transient failure** — `resumeDelayMs` (1–300 s, default 10) is the wait after the host's own retries have run out. `resumeCooldownMs` (5–3600 s, default 120) is the minimum gap between two rescues in one session. `maxResumes` (0–20, default 3) is the per-session quota of **consecutive** rescues: any `completed` turn zeroes it, and `0` disables automatic resume. `chainResumeDelayMs` (1–300 s, default 60) applies to a chained failure: the delay is the larger of it and `resumeDelayMs`, and the cooldown window is skipped; the quota and `providerExcludes` still apply.
- **Output truncated** — `continueDelayMs` (0.5–300 s, default 3), `continueCooldownMs` (5–3600 s, default 60), `maxContinues` (0–20, default 3, also counted per consecutive run: any `completed` turn zeroes it, and `0` disables automatic continue).
- **Unclosed todos** — `resumeOnOpenTodos` (on) plus `unfinishedDelayMs` (1–300 s, default 5), `unfinishedCooldownMs` (5–3600 s, default 120) and `maxUnfinished` (0–20, default 2). It fires only when a turn ends `completed` and the todo list that run wrote itself is still open; turns that ended `aborted` / `interrupted`, or called `ask_user_question`, stand down. That quota is restored only when the todo list closes; while it stays open the count stops at `maxUnfinished`. An experimental toggle `unfinishedSteerMode` (off by default) changes the shape: when a turn is about to close with the list still open, it continues in the same turn via `agent.steer` instead of closing and re-running — sharing the same `maxUnfinished` quota with catch-up.
- **Excluded routes** — `providerExcludes` (empty) names provider routes whose transient-failure `resume` never auto-fires; truncation continue and open-todo catch-up do not consult it. Matching is an exact, case-sensitive comparison against the provider string — no wildcards or prefix/suffix matching.

All of the above are read per decision, so they take effect without restarting the host.

## What does not live on the card

The per-session switch (the switch above the input) and the per-kind counters are runtime memory only: a restart zeroes the counters and clears each kind's cooldown timestamp (opening the cooldown gate once), and the per-session switch falls back to the global `enabled`.

The turn-level manual actions (edit-resend / retry / send-continue, plus resume-interrupted) sit at the tail of the latest completed turn; the dock above the input keeps only the countdown banner, stop-and-reask and the per-session switch. An exhausted automatic quota raises one frame-wide toast (deduplicated per session / turn / kind and not persisted); turning the session switch off also clears the host-side exhausted flag.

`requestRetryMax` (5, range 0–20), `requestRetryBackoffMs` and `requestRetryBackoffCapMs` (30000) are deployment values, deliberately off the card, and the backoff list is replaced as a whole rather than merged. The division of labor is "ask downstream first, take over only when nobody answers": on the waterfall, failures the official `llm-retry` is willing to retry (inside the code table, retries left) belong to it, and this plugin takes only what it passes (outside the table such as `QUOTA`, retries exhausted, `Retry-After` over the ceiling). "Did the host resolve a `retryPolicy`" is not the dividing line — the llm registry backstops unconfigured providers with a default policy, so that condition is always true. Write the deployment values in the `config:` block of this plugin's row in `cordis.patch.yml`; they take effect on restart.

## What it needs from outside

Nothing — no external CLI, interpreter or credential. Request-level rate-limit handling beyond this plugin's share still belongs to the host's retry layer per provider policy (this plugin asks downstream first and takes only what downstream passes).

## Further detail

The scheduler's state machine, how failures are classified and what the turn-tail row and the dock show are in the package README (`README.md` / `README.zh-CN.md`).
