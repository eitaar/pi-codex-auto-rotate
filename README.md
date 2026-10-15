# pi-codex-auto-rotate

Experimental automatic Codex account failover extension for [Pi](https://github.com/earendil-works/pi), designed to work **alongside** [pi-codex-account](https://github.com/fadilsflow/pi-codex-account).

It reads the existing `codex-accounts.json` file. When an `openai-codex` request fails with a recognized quota/rate-limit error, it selects the next eligible saved account, records a cooldown, and attempts to continue the interrupted request. It **does not** log into or create additional accounts.

> **Prototype warning:** 12 local mocked tests passed with Node 22. Real Codex/Pi integration and TypeScript type-checking have not yet been verified. Back up your credentials before trying it, and follow your provider's terms and usage limits.

## Prerequisites

- Pi 1.2+ using `@earendil-works/pi-coding-agent`
- `pi-codex-account` already installed
- At least two distinct saved accounts (with `/codex save <label>`)
- Access only to accounts you are authorized to use

## Install (PowerShell)

Back up your private Pi authentication files first:

```powershell
Copy-Item "$HOME\.pi\agent\auth.json" "$HOME\.pi\agent\auth.json.bak"
Copy-Item "$HOME\.pi\agent\codex-accounts.json" "$HOME\.pi\agent\codex-accounts.json.bak"
```

Keep `pi-codex-account` installed; install this extension from GitHub:

```powershell
pi install git:github.com/eitaar/pi-codex-auto-rotate
```

Restart Pi (or use `/reload`), then check:

```text
/codex-auto status
```

For one-off testing from a cloned repository:

```powershell
git clone https://github.com/eitaar/pi-codex-auto-rotate.git
cd pi-codex-auto-rotate
pi -e .
```

**Do not run this simultaneously with another automatic account-rotation extension.**

## Commands

| Command | Behavior |
|---|---|
| `/codex-auto status` | List saved accounts, active account and cooldowns |
| `/codex-auto on` / `/codex-auto off` | Toggle automatic failover |
| `/codex-auto resume on` / `/codex-auto resume off` | Toggle automatic request continuation |
| `/codex-auto next` | Manually rotate to the next eligible account |
| `/codex-auto reset` | Clear cooldowns and retry-attempt tracking |

## Behavior and safety

- Only known usage-limit errors (such as HTTP 429, rate limit, or quota exceeded) trigger rotation, not unrelated auth/network errors.
- The saved account selection follows JSON insertion order and wraps around.
- An exhausted account cools down until the usage endpoint's reported reset, or for 30 minutes when that cannot be determined.
- A single task cascade attempts each label at most once, avoiding endless retries. If none remains, the task stops.
- The extension modifies the active `openai-codex` OAuth entry in `auth.json` using Pi's `AuthStorage` API, leaving unrelated providers untouched.
- Pi's built-in retry may resolve the error after credential switching. Otherwise, `agent_before_settle` can append a context edit omitting only the failed assistant attempt, followed by an invisible handoff note so the agent can continue without replaying completed tool calls. Whether resumption succeeds depends on the Pi runtime version.
- No background polling and no automatic account creation.

### Data

The Pi agent directory is `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` if set.

| File | Purpose |
|---|---|
| `codex-accounts.json` | Pre-existing accounts, owned by pi-codex-account (contains OAuth secrets) |
| `auth.json` | Pi's active authentication entry (contains OAuth secrets) |
| `codex-auto-rotate-config.json` | Automatic failover, resume and fallback-cooldown settings |
| `codex-auto-rotate-state.json` | Cooldown times and last switch |

**Never commit the private JSON files containing credentials.** They are included in `.gitignore`.

## Local development

```powershell
npm install
npm test
npm run typecheck
```

Tests cover parsing, cooldown selection, rotation, native retry interaction and continuation drafts with a mocked Pi API. Live usage-limit/OAuth integration has not been tested.

## License

MIT. See [LICENSE](./LICENSE).
