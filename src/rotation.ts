/** Pure account-selection and error/usage parsing. Contains no credentials on disk. */
export interface CodexCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  [key: string]: unknown;
}

export interface SavedAccount {
  credential: CodexCredential;
  savedAt: number;
  lastUsedAt?: number;
}

/** Same schema as fadilsflow/pi-codex-account's codex-accounts.json. */
export interface AccountsStore {
  accounts: Record<string, SavedAccount>;
  active?: string;
}

export interface RotationConfig {
  enabled: boolean;
  autoResume: boolean;
  fallbackCooldownMinutes: number;
}

export interface RotationState {
  cooldownUntil: Record<string, number>;
  lastSwitch?: { from: string; to: string; at: number };
}

export const DEFAULT_CONFIG: RotationConfig = {
  enabled: true,
  autoResume: true,
  fallbackCooldownMinutes: 30,
};

export function isCredential(value: unknown): value is CodexCredential {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<CodexCredential>;
  return v.type === "oauth" && typeof v.access === "string" &&
    typeof v.refresh === "string" && Number.isFinite(v.expires);
}

/** Avoid assuming store.active still matches after a manual /login. */
export function findActiveLabel(store: AccountsStore, credential: CodexCredential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.accountId) {
    const matched = Object.entries(store.accounts).find(([, entry]) =>
      entry.credential.accountId && entry.credential.accountId === credential.accountId);
    if (matched) return matched[0];
  }
  const byRefresh = Object.entries(store.accounts).find(([, entry]) =>
    entry.credential.refresh === credential.refresh);
  return byRefresh?.[0];
}

/** Matches known Codex quota errors; unrelated auth, payment and network errors are not retried. */
export function isUsageLimitError(error: string): boolean {
  return /(?:\b429\b|\brate[\s_-]*limit(?:ed|[\s_-]*(?:exceeded|reached|error))?\b|\btoo many requests\b|\busage[\s_-]*limit\b|\busageLimitExceeded\b|\bquota[\s_-]*(?:exceeded|reached|limit)\b|\bresource_exhausted\b)/i.test(error);
}

/** Insertion order follows the order used by /codex save; wraps from last to first. */
export function nextAccount(
  store: AccountsStore,
  activeLabel: string | undefined,
  cooldownUntil: Record<string, number>,
  attemptedLabels: ReadonlySet<string>,
  now = Date.now(),
): string | undefined {
  const labels = Object.entries(store.accounts)
    .filter(([, acct]) => isCredential(acct.credential))
    .map(([label]) => label);
  if (!labels.length) return undefined;
  const activePos = activeLabel ? labels.indexOf(activeLabel) : -1;
  const source = activeLabel ? store.accounts[activeLabel]?.credential : undefined;
  for (let i = 1; i <= labels.length; i++) {
    const label = labels[(activePos + i) % labels.length]!;
    if (label === activeLabel || attemptedLabels.has(label) || (cooldownUntil[label] ?? 0) > now) continue;
    const target = store.accounts[label]?.credential;
    if (!target) continue;
    // Don't rotate between multiple labels that refer to the same OAuth account.
    if (source?.accountId && target.accountId === source.accountId) continue;
    if (source?.refresh === target.refresh) continue;
    return label;
  }
  return undefined;
}

/** Returns milliseconds-until-reset from the *exhausted* Codex usage windows. */
export function quotaResetAt(payload: unknown, now = Date.now()): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const limit = root.rate_limit;
  if (!limit || typeof limit !== "object") return undefined;
  const obj = limit as Record<string, unknown>;
  const resets: number[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const value = obj[key];
    if (!value || typeof value !== "object") continue;
    const win = value as Record<string, unknown>;
    const used = Number(win.used_percent);
    const timestamp = Number(win.reset_at) * 1000;
    if (Number.isFinite(used) && used >= 100 && Number.isFinite(timestamp) && timestamp > now) {
      resets.push(timestamp);
    }
  }
  return resets.length ? Math.max(...resets) : undefined;
}

export function pruneCooldowns(state: RotationState, now = Date.now()): RotationState {
  return {
    ...state,
    cooldownUntil: Object.fromEntries(Object.entries(state.cooldownUntil)
      .filter(([, until]) => Number.isFinite(until) && until > now)),
  };
}
