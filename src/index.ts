/** Automatic Codex quota failover for users of pi-codex-account.
 * Pi >= 1.2; respects the existing /codex account store and command namespace.
 */
import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_CONFIG, findActiveLabel, isCredential, isUsageLimitError,
  nextAccount, pruneCooldowns, quotaResetAt,
  type AccountsStore, type CodexCredential, type RotationConfig, type RotationState,
} from "./rotation.ts";

const PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const STATUS_KEY = "codex-auto-rotate";
const RESET_SAFETY_MS = 30_000;

function agentDir(): string {
  const custom = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!custom) return join(homedir(), ".pi", "agent");
  if (custom === "~") return homedir();
  if (custom.startsWith("~/") || custom.startsWith("~\\")) return join(homedir(), custom.slice(2));
  return custom;
}
const storePath = () => join(agentDir(), "codex-accounts.json");
const authPath = () => join(agentDir(), "auth.json");
const configPath = () => join(agentDir(), "codex-auto-rotate-config.json");
const statePath = () => join(agentDir(), "codex-auto-rotate-state.json");

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  // Fail closed on malformed files; never replace user credentials with {}.
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeSecure(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch { /* Windows ACLs may not support POSIX chmod. */ }
  renameSync(temp, path);
}

function readStore(): AccountsStore {
  const raw = readJson<unknown>(storePath(), { accounts: {} });
  if (!raw || typeof raw !== "object" || !("accounts" in raw)) throw new Error("Invalid codex-accounts.json");
  const value = raw as AccountsStore;
  if (!value.accounts || typeof value.accounts !== "object" || Array.isArray(value.accounts)) {
    throw new Error("Invalid accounts object in codex-accounts.json");
  }
  return value;
}
function readConfig(): RotationConfig {
  const value = readJson<Partial<RotationConfig>>(configPath(), {});
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_CONFIG.enabled,
    autoResume: typeof value.autoResume === "boolean" ? value.autoResume : DEFAULT_CONFIG.autoResume,
    fallbackCooldownMinutes: typeof value.fallbackCooldownMinutes === "number" &&
      value.fallbackCooldownMinutes >= 1 && value.fallbackCooldownMinutes <= 10080
      ? value.fallbackCooldownMinutes : DEFAULT_CONFIG.fallbackCooldownMinutes,
  };
}
function readState(): RotationState {
  const raw = readJson<Partial<RotationState>>(statePath(), {});
  const times = raw.cooldownUntil && typeof raw.cooldownUntil === "object" && !Array.isArray(raw.cooldownUntil)
    ? raw.cooldownUntil : {};
  return pruneCooldowns({ cooldownUntil: times, lastSwitch: raw.lastSwitch });
}

async function activeCredential(): Promise<CodexCredential | undefined> {
  // AuthStorage is internal to Pi. Only readStoredCredential is exported
  // from @earendil-works/pi-coding-agent's public entry point.
  const item = readStoredCredential(PROVIDER, authPath());
  return isCredential(item) ? item : undefined;
}

/** Persist a new active credential while preserving every other provider. */
async function activate(credential: CodexCredential): Promise<void> {
  // Fail closed: do not silently create an empty auth.json if it is missing
  // or malformed. The existing pi-codex-account extension uses the same
  // on-disk auth.json format.
  const auth = readJson<unknown>(authPath(), null);
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("Invalid or missing auth.json; no credentials were changed");
  }
  const entries = auth as Record<string, unknown>;
  if (!isCredential(entries[PROVIDER])) {
    throw new Error("No active openai-codex OAuth credential; no credentials were changed");
  }
  // Expire the snapshot so Pi refreshes with the selected account's token.
  writeSecure(authPath(), {
    ...entries,
    [PROVIDER]: { ...credential, type: "oauth", expires: 0 },
  });
}

/** Save the newest active OAuth token before switching, as /codex switch does. */
function snapshotSource(store: AccountsStore, from: string | undefined, credential: CodexCredential | undefined): void {
  if (from && credential && store.accounts[from]) {
    store.accounts[from] = { ...store.accounts[from]!, credential: { ...credential } };
  }
}

async function determineCooldown(credential: CodexCredential | undefined, fallbackMinutes: number): Promise<number> {
  const fallbackUntil = Date.now() + fallbackMinutes * 60_000;
  if (!credential || !credential.access || credential.expires <= Date.now()) return fallbackUntil;
  try {
    // This endpoint is the same one used by pi-codex-account's /codex usage.
    const response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${credential.access}`, "User-Agent": "pi-codex-auto-rotate" },
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) return fallbackUntil;
    const reset = quotaResetAt(await response.json());
    // Ignore nonsensical reset timestamps.
    if (reset && reset <= Date.now() + 8 * 24 * 60 * 60 * 1000) return reset + RESET_SAFETY_MS;
  } catch { /* Network trouble is not a reason to lose the original task. */ }
  return fallbackUntil;
}

export default function (pi: ExtensionAPI): void {
  /** Bound to one live user task; don't attempt the same account twice in a cascade. */
  let attempted = new Set<string>();
  let pendingFailure: { entryId: string; switched: boolean } | undefined;
  let switching = false;

  function notify(message: string, level: "info" | "warning" | "error" = "info", ctx?: { ui: { notify: (text: string, level: "info" | "warning" | "error") => void } }) {
    if (ctx) ctx.ui.notify(`Codex auto: ${message}`, level);
  }

  async function rotate(ctx: { ui: { notify: (text: string, level: "info" | "warning" | "error") => void } }, cause: "limit" | "manual"): Promise<boolean> {
    if (switching) return false;
    switching = true;
    try {
      const store = readStore();
      const current = await activeCredential();
      const from = findActiveLabel(store, current);
      const state = readState();
      const config = readConfig();
      if (cause === "limit" && from) {
        attempted.add(from);
        // Record a conservative fallback first; the API may give a more precise reset time.
        state.cooldownUntil[from] = await determineCooldown(current, config.fallbackCooldownMinutes);
      }
      const to = nextAccount(store, from, state.cooldownUntil, attempted);
      if (!to) {
        writeSecure(statePath(), state);
        notify("No unused available saved account. Stopping rather than retrying in a loop.", "warning", ctx);
        return false;
      }
      const credential = store.accounts[to]?.credential;
      if (!isCredential(credential)) return false;
      snapshotSource(store, from, current);
      // Credential is written before the state: a failed auth write does not claim success.
      await activate(credential);
      store.accounts[to]!.lastUsedAt = Date.now();
      store.active = to;
      writeSecure(storePath(), store);
      attempted.add(to);
      state.lastSwitch = { from: from ?? "(unsaved)", to, at: Date.now() };
      writeSecure(statePath(), state);
      notify(`${from ?? "(unsaved)"} → ${to}${cause === "limit" ? " (usage limit)" : ""}`, "info", ctx);
      return true;
    } catch (error) {
      notify(`Switch failed: ${error instanceof Error ? error.message : String(error)}`, "error", ctx);
      return false;
    } finally {
      switching = false;
    }
  }

  // New submitted user work resets the attempt budget; an automatic retry does not.
  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") {
      attempted = new Set();
      pendingFailure = undefined;
    }
  });

  // A turn-ending provider error is a hard exit. Switching here lets Pi's own
  // native retry use the new auth, before our recovery boundary gets involved.
  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason !== "error") {
      if (event.message.stopReason !== "aborted") {
        pendingFailure = undefined;
        attempted = new Set();
      }
      return;
    }
    if (ctx.model?.provider !== PROVIDER || !readConfig().enabled) return;
    if (!isUsageLimitError(event.message.errorMessage ?? "")) return;
    const switched = await rotate(ctx, "limit");
    pendingFailure = { entryId: event.messageEntryId, switched };
  });

  // Pi cannot continue a failed turn via turn_end. This is the supported
  // post-retry recovery hook; omit *only* the failed assistant message from
  // projected model context. Session history remains append-only and intact.
  pi.on("agent_before_settle", (event, ctx) => {
    const failed = pendingFailure;
    pendingFailure = undefined;
    if (!failed?.switched || event.outcome !== "error" || !readConfig().autoResume) return;
    if (ctx.model?.provider !== PROVIDER || !event.context.contextMessages.some((m) => m.role === "user")) return;
    return {
      entries: [
        { type: "context_edit" as const, targetId: failed.entryId, replacement: null },
        // A quiet handoff note makes the context runnable even if the prior
        // projected message was another assistant turn, without replaying tools.
        {
          type: "custom_message" as const,
          customType: "codex-auto-rotate-handoff",
          content: "The previous provider attempt failed due to an account usage limit. Credentials have been switched. Continue the existing user request from the current state. Do not repeat completed tool actions unless necessary.",
          display: false,
        },
      ],
      continue: true,
    };
  });

  pi.registerCommand("codex-auto", {
    description: "Codex account auto-failover: status | on | off | resume on|off | next | reset",
    handler: async (args, ctx) => {
      try {
        const [command = "status", option] = args.trim().split(/\s+/);
        if (command === "on" || command === "off") {
          const cfg = readConfig();
          cfg.enabled = command === "on";
          writeSecure(configPath(), cfg);
          notify(`Automatic switching ${cfg.enabled ? "enabled" : "disabled"}.`, "info", ctx);
        } else if (command === "resume" && (option === "on" || option === "off")) {
          const cfg = readConfig();
          cfg.autoResume = option === "on";
          writeSecure(configPath(), cfg);
          notify(`Automatic continuation ${cfg.autoResume ? "enabled" : "disabled"}.`, "info", ctx);
        } else if (command === "reset") {
          writeSecure(statePath(), { cooldownUntil: {} } satisfies RotationState);
          attempted = new Set();
          notify("Cooldowns and retry-attempt tracking cleared.", "info", ctx);
        } else if (command === "next") {
          if (await rotate(ctx, "manual")) {
            // Commands, unlike boundary event handlers, are allowed to reload.
            await ctx.reload();
          }
        } else if (command === "status") {
          const cfg = readConfig();
          const store = readStore();
          const state = readState();
          const active = findActiveLabel(store, await activeCredential()) ?? "(unsaved)";
          const lines = Object.keys(store.accounts).map(label => {
            const until = state.cooldownUntil[label] ?? 0;
            return `${label === active ? "*" : " "} ${label}${until > Date.now() ? ` — cooling until ${new Date(until).toLocaleString()}` : ""}`;
          });
          notify(`enabled=${cfg.enabled}, autoResume=${cfg.autoResume}, active=${active}\n${lines.join("\n") || "No saved accounts; use /codex save <label>."}`, "info", ctx);
        } else {
          notify("Usage: /codex-auto [status|on|off|resume on|resume off|next|reset]", "warning", ctx);
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error", ctx);
      }
    },
  });
}
