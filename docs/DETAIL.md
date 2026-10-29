# Session rescue

Rescues a stalled turn: it re-sends after a transient provider failure, continues an output that was cut short, and runs on until unclosed todos are actually closed.

## What the card changes

Three independent automatic actions, each with its own wait, per-session cooldown and quota. Delays are entered in seconds and stored in milliseconds.

- **Transient failure** — `enabled` (on); with it off only the manual edit / retry / continue entries remain. `resumeDelayMs` (1–300 s, default 10) is the wait after the host's own retries have run out. `resumeCooldownMs` (5–3600 s, default 120) is the minimum gap between two rescues in one session. `maxResumes` (0–20, default 3) is the quota. `chainResumeDelayMs` (1–300 s, default 60) applies to a chained failure, which skips the cooldown so it can cross a rate-limit window.
- **Output truncated** — `continueDelayMs` (0.5–300 s, default 3), `continueCooldownMs` (5–3600 s, default 60), `maxContinues` (0–20, default 3).
- **Unclosed todos** — `resumeOnOpenTodos` (on) plus `unfinishedDelayMs` (1–300 s, default 5), `unfinishedCooldownMs` (5–3600 s, default 120) and `maxUnfinished` (0–20, default 2). That quota is restored once the todo list closes, so a long task is not silently capped.
- **Excluded routes** — `providerExcludes` (empty) names provider routes that must never be auto-resumed.

All of the above are read per decision, so they take effect without restarting the host.

## What does not live on the card

The per-session switch (the label next to the input) and the resume counters are runtime memory only: a restart resets them to the global defaults.

`requestRetryMax` (5), `requestRetryBackoffMs` and `requestRetryBackoffCapMs` (30000) are deployment values, deliberately off the card, and the backoff list is replaced as a whole rather than merged. Write them in the `config:` block of this plugin's row in `cordis.patch.yml`; they take effect on restart.

## What it needs from outside

Nothing — no external CLI, interpreter or credential. Request-level 429 handling above its own cap is delegated back to the host's retry layer.

## Further detail

The scheduler's state machine, how failures are classified and what the dock shows are in the package README (`README.md` / `README.zh-CN.md`).
