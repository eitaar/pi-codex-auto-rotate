# pi-codex-auto-rotate

Automatic Codex quota failover for [Pi](https://github.com/earendil-works/pi), designed to work alongside [pi-codex-account](https://github.com/fadilsflow/pi-codex-account) and reuse its saved accounts.

When an `openai-codex` model request hits a recognized usage-limit error, this extension switches to another eligible saved account, preserves the current Pi session, and attempts to continue the interrupted task. It does not log in to or create accounts.

> **Status:** A real-world account switch and automatic continuation have been reported successful. The bounded cycling change in v0.2.0 has local mocked tests; live cycling is not yet verified. Use accounts you are authorized to access and follow provider terms.

## Install and update (PowerShell)

Requires Pi 1.2+ using `@earendil-works/pi-coding-agent` and `pi-codex-account`, with at least two saved accounts (`/codex save <label>`). Back up your private Pi credentials first:

```powershell
Copy-Item "$HOME\.pi\agent\auth.json" "$HOME\.pi\agent\auth.json.bak"
Copy-Item "$HOME\.pi\agent\codex-accounts.json" "$HOME\.pi\agent\codex-accounts.json.bak"
```

First install: `pi install git:github.com/eitaar/pi-codex-auto-rotate`.
For existing installations:

```powershell
pi update --extensions
```

Restart Pi or run `/reload`, then `/codex-auto status`. Do not run alongside another account-rotation extension.

## Commands

| Command | Behavior |
|---|---|
| `/codex-auto status` | Show active account, cooldowns, and `switches=used/max` |
| `/codex-auto on` / `off` | Enable or disable auto-switch |
| `/codex-auto resume on` / `off` | Enable or disable automatic continuation |
| `/codex-auto max 8` | Set the maximum automatic switches per user task (1–100; default **8**) |
| `/codex-auto next` | Manually select the next available account (does not spend switch budget) |
| `/codex-auto reset` | Clear cooldowns and the current task switch count |

## Bounded cycling (v0.2.0)

```text
A --quota error--> B --quota error--> C --quota error--> A (only after A's cooldown ends)
```

- Rotation wraps from the last account back to the first, **only if its cooldown has expired**. All cooling-down accounts are skipped.
- Every successful **automatic** switch counts toward the `maxSwitchesPerTask` limit. When the limit is reached, switching stops for the current user task.
- Successful model replies do not reset the counter. A new user-submitted prompt, or `/codex-auto reset`, does.
- If no other account is eligible, switching stops immediately; it **does not wait or poll in the background** for cooldown expiration.
- Exhausted accounts cool down until a reported reset or, if no reset is known, for 30 minutes.
- Auth errors (401) and unrelated network errors do not trigger switching.
- Pi's retry flow or the `agent_before_settle` continuation hook attempts to resume in the same session. Already-completed external tool side effects are not automatically rolled back.

## Data

Default Pi agent directory: `~/.pi/agent`, overridable with `PI_CODING_AGENT_DIR`.

| File | Purpose |
|---|---|
| `codex-accounts.json` | Saved account credentials managed by pi-codex-account |
| `auth.json` | Active Pi credentials |
| `codex-auto-rotate-config.json` | Enabled status, auto resume, fallback cooldown, maximum switches |
| `codex-auto-rotate-state.json` | Cooldown timestamps and last switch |

**Never commit private credential JSON files.** Config and cooldown persist across restarts; the task-local switch counter is in memory and resets upon Pi restart.

## Development

```powershell
npm install
npm test
npm run typecheck
```

18 local mocked tests have passed (Node 22). Pi's actual dependency typecheck and the updated cycling behavior against live Codex limits remain unverified.

## License

MIT. See [LICENSE](./LICENSE).
