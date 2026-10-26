/**
 * Token Stats Extension
 *
 * Live-only version:
 * - No sendMessage()
 * - No persistence
 * - No custom renderer
 * - No widget
 * - No commands
 * - Shows live progress through ctx.ui.setWorkingIndicator()
 * - Shows finalized message stats through ctx.ui.notify()
 * - Shows finalized agent stats on agent_end through ctx.ui.notify()
 * - Shows provider balance in the footer through ctx.ui.setStatus()
 * - Shows spend on the live, message, and agent stats lines
 * - Optionally persists session spend and balance across reloads
 * - Optionally stores stats lines in the session to restore them after reload
 *
 * Message format:
 * IBM/Granite4-7B-A1B-H ✓ 17.9s (↑15.6s + ↓2.3s) · ↑9.8k @ 625.5/s · ↓114 @ 49.9/s · Cache R2.0k W0 · 0.13¢ (€0.001) off-peak · 💰 $1.68 (€1.50)
 *
 * Agent-end notify format:
 * <last message stats>
 *
 * Agent ✓ 20.1s (↑15.6s + ↓2.3s) · ↑9.8k @ 625.5/s · ↓114 @ 49.9/s · Cache R2.0k W0 · 0.13¢ (€0.001) · 💰 $1.68 (€1.50)
 *
 * Footer line (configured providers only):
 * 💰 deepseek $1.67 (€1.59) · 💸 €0.081 · off-peak
 *
 * Usage:
 * pi -e ./token-stats.ts
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { Text } from "@earendil-works/pi-tui";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────────────

interface LiveStats {
  model: string;
  prefillTimeMs: number;
  generationTimeMs: number;
  estimatedOutputTokens: number;
  generationTokensPerSecond: number;
  /** Estimated spend of the in-flight message, in the display currency. */
  spend: number | null;
  tier: "peak" | "off-peak" | null;
}

interface FinalStats {
  model: string;

  prefillTimeMs: number;
  generationTimeMs: number;
  totalTimeMs: number;

  prefillTokensPerSecond: number;
  generationTokensPerSecond: number;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;

  totalTokens: number;
  costTotal: number;
  stopReason: string;
  /** Message spend in the display currency, null when not priced. */
  spend: number | null;
  tier: "peak" | "off-peak" | null;
}

interface AgentStats {
  label: string;

  agentTimeMs: number;
  prefillTimeMs: number;
  generationTimeMs: number;

  prefillTokensPerSecond: number;
  generationTokensPerSecond: number;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;

  totalTokens: number;
  costTotal: number;
  messages: number;
  /** Agent-run spend in the display currency, null when not priced. */
  spend: number | null;
}

interface SessionTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costTotal: number;
}

interface ModelPrice {
  /** Price per 1M cache-hit input tokens (peak rate). */
  cacheHit: number;
  /** Price per 1M cache-miss input tokens (peak rate). */
  cacheMiss: number;
  /** Price per 1M output tokens (peak rate). */
  output: number;
}

interface SpendingConfig {
  enabled: boolean;
  /** Currency the prices are quoted in. */
  currency: string;
  /** Multiplier applied to the peak prices outside peak hours (DeepSeek: 0.5). */
  offPeakMultiplier: number;
  /** Peak windows in UTC, e.g. [["01:00", "04:00"], ["06:00", "10:00"]]. */
  peakWindowsUtc: [string, string][];
  /** Weekdays that can be peak, e.g. ["Mon", ..., "Fri"]. */
  peakWeekdays: string[];
  /** Public holidays (YYYY-MM-DD, UTC) that are always off-peak. */
  holidays: string[];
  /** Prices keyed by model id; a key also matches when the model id contains it. */
  models: Record<string, ModelPrice>;
}

interface BalanceConfig {
  url: string;
  keyName: string;
  /** Env file holding the key, e.g. "~/.pi/keys/ds.env". */
  envFile: string;
  /** Show the balance in this currency (e.g. "CNY"); defaults to the API currency. */
  currency?: string;
  /** Balance below this amount (warning color) in `currency`. */
  low?: number;
  /** Balance below this amount (error color) in `currency`. */
  critical?: number;
  /** Emoji shown before the provider name in the footer. */
  emoji?: string;
  /** Label before the session spend in the footer; defaults to 💸. */
  spentLabel?: string;
  /** Append the balance to the message and agent notify lines. */
  showInMessages?: boolean;
}

interface ProviderConfig {
  balance?: BalanceConfig;
  spending?: SpendingConfig;
}

interface StatsConfig {
  /** Display currency for balance and spending. */
  currency: string;
  /** How long fetched FX rates stay valid, in minutes. */
  fxCacheMinutes?: number;
  /** Keep spend and balance across reloads and sessions. */
  persistence?: PersistenceConfig;
  providers: Record<string, ProviderConfig>;
}

interface PersistenceConfig {
  enabled: boolean;
  /** State file path; defaults to ~/.pi/token-stats-state.json. */
  path?: string;
  /** Store stats lines in the session so they return after a reload. */
  lines?: boolean;
}

interface StatsLineEntry {
  /** Extension runtime that wrote the entry. */
  boot: string;
  kind: "message" | "agent";
  line: string;
  at: number;
}

interface PersistedBalance {
  currency: string;
  total: number;
  at: number;
}

interface PersistedSession {
  spend: number;
  currency: string;
  updatedAt: number;
}

interface PersistedState {
  version: 1;
  sessions: Record<string, PersistedSession>;
  balances: Record<string, PersistedBalance>;
}

interface BalanceInfo {
  currency: string;
  total: number;
}

interface FxRate {
  rate: number;
  at: number;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function padCounter(text: string): string {
  return text.padStart(3, " ");
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return padCounter("0");

  if (n >= 1000) {
    return padCounter(`${(n / 1000).toFixed(1)}k`);
  }

  return padCounter(`${Math.round(n)}`);
}

function formatRateNumber(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "0.0";

  if (tps >= 1000) {
    return `${(tps / 1000).toFixed(1)}k`;
  }

  return tps.toFixed(1);
}

function calcTps(tokens: number, ms: number): number {
  return tokens > 0 && ms > 0 ? (tokens / ms) * 1000 : 0;
}

/**
 * Count characters across every streamed block type, not just plain text.
 *
 * Reasoning models (e.g. DeepSeek V4) stream `thinking` and `toolCall` blocks
 * and often emit no `text` block at all, so counting only `text` yields 0.
 *
 *  - TextContent     -> block.text
 *  - ThinkingContent -> block.thinking  (NOT block.text)
 *  - ToolCall        -> block.arguments
 */
function countContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let count = 0;

  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block)) continue;

    if (block.type === "text" && typeof block.text === "string") {
      count += block.text.length;
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string"
    ) {
      count += block.thinking.length;
    } else if (block.type === "toolCall" && block.arguments != null) {
      try {
        count += JSON.stringify(block.arguments).length;
      } catch {
        /* ignore unserializable args */
      }
    }
  }

  return count;
}

function safeUsage(message: any) {
  return {
    input: message.usage?.input ?? 0,
    output: message.usage?.output ?? 0,
    cacheRead: message.usage?.cacheRead ?? 0,
    cacheWrite: message.usage?.cacheWrite ?? 0,
    totalTokens: message.usage?.totalTokens ?? 0,
    costTotal: message.usage?.cost?.total ?? 0,
  };
}

// ─── Balance / spending ──────────────────────────────────────────────────────

const CONFIG_PATH =
  process.env.PI_TOKEN_STATS_CONFIG ?? join(homedir(), ".pi", "token-stats.json");

const STATUS_KEY = "token-stats";
const STATS_LINE_TYPE = "token-stats-line";
const FX_URL = "https://api.frankfurter.dev/v1/latest";
const FETCH_TIMEOUT_MS = 8000;

function currencySymbol(code: string): string {
  switch (code.toUpperCase()) {
    case "EUR":
      return "€";
    case "USD":
      return "$";
    case "CNY":
      return "¥";
    case "GBP":
      return "£";
    default:
      return `${code} `;
  }
}

/** Compact money formatting: rounded decimals, `<` for tiny non-zero values. */
function formatMoney(value: number, code: string, decimals = 3): string {
  const sym = currencySymbol(code);
  if (!Number.isFinite(value)) return `${sym}?`;

  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  const smallest = (1 / scale).toFixed(decimals);

  if (value > 0 && rounded === 0) return `${sym}<${smallest}`;
  if (value < 0 && rounded === 0) return `-${sym}<${smallest}`;
  return `${sym}${rounded.toFixed(decimals)}`;
}

/** Spend below this amount (display currency) is shown in cents. */
const CENTS_THRESHOLD = 0.1;

function formatCents(value: number): string {
  const rounded = Math.round(value * 100 * 100) / 100;
  if (value > 0 && rounded === 0) return "<0.01¢";
  return `${rounded.toFixed(2)}¢`;
}

function expandHome(file: string): string {
  if (file === "~") return homedir();
  if (file.startsWith("~/")) return join(homedir(), file.slice(2));
  return file;
}

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Read a single KEY=VALUE entry from an env file, falling back to process.env. */
function readApiKey(envFile: string, keyName: string): string | undefined {
  try {
    const content = readFileSync(expandHome(envFile), "utf8");

    for (const line of content.split("\n")) {
      const match = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
      );
      if (!match || match[1] !== keyName) continue;
      return match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* missing or unreadable env file */
  }

  return process.env[keyName]?.trim() || undefined;
}

function parseUtcMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function currentTier(spending: SpendingConfig, now: Date): "peak" | "off-peak" {
  const day = now.toISOString().slice(0, 10);
  if (spending.holidays.includes(day)) return "off-peak";
  if (!spending.peakWeekdays.includes(WEEKDAYS[now.getUTCDay()])) {
    return "off-peak";
  }

  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const [start, end] of spending.peakWindowsUtc) {
    if (minutes >= parseUtcMinutes(start) && minutes < parseUtcMinutes(end)) {
      return "peak";
    }
  }

  return "off-peak";
}

function priceFor(
  spending: SpendingConfig,
  modelId: string,
): ModelPrice | undefined {
  if (spending.models[modelId]) return spending.models[modelId];

  let best: ModelPrice | undefined;
  let bestLength = 0;

  for (const [key, price] of Object.entries(spending.models)) {
    if (modelId.includes(key) && key.length > bestLength) {
      best = price;
      bestLength = key.length;
    }
  }

  return best;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function tokenStatsExtension(pi: ExtensionAPI) {
  // Identifies this extension runtime. Entries written here stay hidden and
  // live output comes from notify(); after a reload a new runtime renders them
  // as history, so only lines lost with the previous runtime reappear.
  const bootId = randomUUID();

  pi.registerEntryRenderer<StatsLineEntry>(
    STATS_LINE_TYPE,
    (entry, _options, theme) => {
      const data = entry.data;
      if (!data || data.boot === bootId) return undefined;
      return new Text(theme.fg("dim", data.line), 0, 0);
    },
  );

  let requestSentAt = 0;
  let firstTokenAt = 0;

  // Monotonic char counter fed from streaming deltas. Content blocks may be
  // partial/rewritten, so we keep the max of this and the block scan.
  let streamedChars = 0;

  let agentStartedAt = 0;
  let agentActive = false;

  let liveStats: LiveStats | null = null;
  let finalStats: FinalStats | null = null;
  let lastMessageNotifyText = "";

  let agentInputTokens = 0;
  let agentOutputTokens = 0;
  let agentCacheReadTokens = 0;
  let agentCacheWriteTokens = 0;
  let agentTotalTokens = 0;
  let agentCostTotal = 0;
  let agentPrefillTimeMs = 0;
  let agentGenerationTimeMs = 0;
  let agentAssistantMessages = 0;
  let agentLastModel = "";

  const sessionTotals: SessionTotals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costTotal: 0,
  };

  // ── Balance / spending state ─────────────────────────────────────────────

  let config: StatsConfig | null = null;
  const balances = new Map<string, BalanceInfo>();
  const fxRates = new Map<string, FxRate>();

  let activeProvider = "";
  let activeModel = "";

  let sessionSpend: number | null = null;
  let agentSpend: number | null = null;

  // Token breakdown of the previous message, used to estimate live spend.
  let prevInputTokens = 0;
  let prevCacheReadTokens = 0;
  let prevCacheWriteTokens = 0;

  let configWarningShown = false;

  let statePath: string | null = null;
  let state: PersistedState = { version: 1, sessions: {}, balances: {} };

  // ── Config / HTTP ────────────────────────────────────────────────────────

  function loadConfig(ctx: ExtensionContext) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as StatsConfig;
      config.currency = config.currency || "EUR";
    } catch (error) {
      config = null;
      const code = (error as { code?: string })?.code;
      if (code !== "ENOENT" && !configWarningShown) {
        configWarningShown = true;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `token-stats: cannot read ${CONFIG_PATH}: ${message}`,
          "warning",
        );
      }
    }
  }

  async function getRate(from: string, to: string): Promise<number | null> {
    if (from === to) return 1;
    if (!config) return null;
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return null;

    const key = `${from}:${to}`;
    const cached = fxRates.get(key);
    const ttlMs = (config.fxCacheMinutes ?? 60) * 60_000;
    if (cached && Date.now() - cached.at < ttlMs) return cached.rate;

    try {
      const url = new URL(FX_URL);
      url.searchParams.set("base", from);
      url.searchParams.set("symbols", to);

      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return cached?.rate ?? null;

      const data = (await res.json()) as { rates?: Record<string, number> };
      const rate = data.rates?.[to];
      if (typeof rate !== "number") return cached?.rate ?? null;

      fxRates.set(key, { rate, at: Date.now() });
      return rate;
    } catch {
      return cached?.rate ?? null;
    }
  }

  async function fetchBalance(balance: BalanceConfig): Promise<BalanceInfo | null> {
    const key = readApiKey(balance.envFile, balance.keyName);
    if (!key) return null;

    // The URL comes from the user's own token-stats.json, not from model input.
    const endpoint = parseHttpsUrl(balance.url);
    if (!endpoint) return null;

    try {
      // pi-lens-ignore: ts-ssrf -- endpoint is validated as https above and read from the local user config
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as {
        balance_infos?: { currency: string; total_balance: string }[];
      };
      const infos = data.balance_infos ?? [];
      const info =
        infos.find((i) => i.currency === balance.currency) ??
        infos.find((i) => i.currency === "CNY") ??
        infos[0];
      const total = Number(info?.total_balance);

      if (!info || !Number.isFinite(total)) return null;
      return { currency: info.currency, total };
    } catch {
      return null;
    }
  }

  // ── Spend accounting ─────────────────────────────────────────────────────

  /** Convert with an already-cached FX rate; null when the rate is missing. */
  function convert(amount: number, from: string, to: string): number | null {
    if (from === to) return amount;
    const rate = fxRates.get(`${from}:${to}`)?.rate;
    return rate == null ? null : amount * rate;
  }

  /** Cost of one message in the display currency, or null when not priced. */
  async function messageCost(
    provider: string,
    modelId: string,
    usage: ReturnType<typeof safeUsage>,
  ): Promise<{ amount: number; tier: "peak" | "off-peak" } | null> {
    const spending = config?.providers?.[provider]?.spending;
    const displayCurrency = config?.currency;
    if (!spending?.enabled || !displayCurrency) return null;

    const price = priceFor(spending, modelId);
    if (!price) return null;

    const tier = currentTier(spending, new Date());
    const factor = tier === "peak" ? 1 : (spending.offPeakMultiplier ?? 1);

    const raw =
      (usage.cacheRead * price.cacheHit +
        (usage.input + usage.cacheWrite) * price.cacheMiss +
        usage.output * price.output) /
      1_000_000;

    const rate = await getRate(spending.currency, displayCurrency);
    if (rate == null) return null;

    return { amount: raw * factor * rate, tier };
  }

  /** Rough spend of the in-flight message: previous prefill + estimated output. */
  function estimateLiveSpend(): { amount: number; tier: "peak" | "off-peak" } | null {
    const spending = config?.providers?.[activeProvider]?.spending;
    const displayCurrency = config?.currency;
    if (!spending?.enabled || !displayCurrency || !liveStats) return null;

    const price = priceFor(spending, activeModel);
    if (!price) return null;

    const tier = currentTier(spending, new Date());
    const factor = tier === "peak" ? 1 : (spending.offPeakMultiplier ?? 1);

    const raw =
      (prevCacheReadTokens * price.cacheHit +
        (prevInputTokens + prevCacheWriteTokens) * price.cacheMiss +
        liveStats.estimatedOutputTokens * price.output) /
      1_000_000;

    const amount = convert(raw * factor, spending.currency, displayCurrency);
    return amount == null ? null : { amount, tier };
  }

  // ── Status line ──────────────────────────────────────────────────────────

  function balanceColor(
    balance: BalanceConfig | undefined,
    amount: number,
  ): "error" | "warning" | "accent" {
    if (balance?.critical != null && amount < balance.critical) return "error";
    if (balance?.low != null && amount < balance.low) return "warning";
    return "accent";
  }

  function setStatusLine(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    const providerConfig = config?.providers?.[activeProvider];
    if (!providerConfig || !config) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const displayCurrency = config.currency;
    const theme = ctx.ui.theme;
    const chunks: string[] = [];

    const balance = balances.get(activeProvider);
    if (balance) {
      const shownCurrency = providerConfig.balance?.currency || balance.currency;
      const primary = convert(balance.total, balance.currency, shownCurrency);

      if (primary != null) {
        const secondary = convert(primary, shownCurrency, displayCurrency);
        const converted =
          secondary == null
            ? ""
            : theme.fg("dim", ` (${formatMoney(secondary, displayCurrency, 2)})`);
        chunks.push(
          theme.fg(balanceColor(providerConfig.balance, primary), formatMoney(primary, shownCurrency, 2)) +
            converted,
        );
      }
    }

    if (sessionSpend != null) {
      const spentLabel = providerConfig.balance?.spentLabel ?? "💸";
      chunks.push(theme.fg("dim", `${spentLabel} ${formatSpend(sessionSpend, null)}`));
    }

    const spending = providerConfig.spending;
    if (spending?.enabled) {
      const tier = currentTier(spending, new Date());
      chunks.push(theme.fg(tier === "peak" ? "warning" : "success", tier));
    }

    if (chunks.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const separator = theme.fg("dim", " · ");
    const label = theme.fg(
      "dim",
      `${providerConfig.balance?.emoji ? `${providerConfig.balance.emoji} ` : ""}${activeProvider} `,
    );
    ctx.ui.setStatus(STATUS_KEY, label + chunks.join(separator));
  }

  /** Fetch balance + FX, persist, then redraw the footer line. */
  async function refreshBalance(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    const balanceConfig = config?.providers?.[activeProvider]?.balance;
    if (!config || !balanceConfig) return;

    const provider = activeProvider;
    const displayCurrency = config.currency;

    const balance = await fetchBalance(balanceConfig);
    if (balance) {
      balances.set(provider, balance);
      saveState(ctx);

      const shownCurrency = balanceConfig.currency || balance.currency;
      await getRate(balance.currency, shownCurrency);
      await getRate(shownCurrency, displayCurrency);
    }

    setStatusLine(ctx);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  function sessionId(ctx: ExtensionContext): string | null {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return null;
    }
  }

  function loadPersistedState(ctx: ExtensionContext) {
    const persistence = config?.persistence;
    statePath = persistence?.enabled
      ? expandHome(persistence.path ?? join(homedir(), ".pi", "token-stats-state.json"))
      : null;
    state = { version: 1, sessions: {}, balances: {} };
    if (!statePath) return;

    try {
      const saved = JSON.parse(readFileSync(statePath, "utf8")) as PersistedState;
      state = {
        version: 1,
        sessions: saved.sessions ?? {},
        balances: saved.balances ?? {},
      };
    } catch {
      return;
    }

    for (const [provider, balance] of Object.entries(state.balances)) {
      balances.set(provider, { currency: balance.currency, total: balance.total });
    }

    const id = sessionId(ctx);
    const savedSession = id ? state.sessions[id] : undefined;
    if (savedSession && savedSession.currency === config?.currency) {
      sessionSpend = savedSession.spend;
    }
  }

  function saveState(ctx: ExtensionContext) {
    if (!statePath || !config) return;

    const id = sessionId(ctx);
    if (id && sessionSpend != null) {
      state.sessions[id] = {
        spend: sessionSpend,
        currency: config.currency,
        updatedAt: Date.now(),
      };
    }

    for (const [provider, balance] of balances) {
      state.balances[provider] = { ...balance, at: Date.now() };
    }

    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    state.sessions = Object.fromEntries(
      Object.entries(state.sessions)
        .filter(([, entry]) => entry.updatedAt >= cutoff)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, 100),
    );

    try {
      writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
      renameSync(`${statePath}.tmp`, statePath);
    } catch {
      /* ignore unwritable state file */
    }
  }

  /** Store a stats line as a session entry so later runtimes render it. */
  function appendLineEntry(kind: StatsLineEntry["kind"], line: string) {
    if (!config?.persistence?.lines) return;

    pi.appendEntry<StatsLineEntry>(STATS_LINE_TYPE, {
      boot: bootId,
      kind,
      line,
      at: Date.now(),
    });
  }

  // ── Agent lifecycle ──────────────────────────────────────────────────────

  pi.on("agent_start", (_event, _ctx) => {
    agentStartedAt = Date.now();
    agentActive = true;
    agentSpend = null;

    agentInputTokens = 0;
    agentOutputTokens = 0;
    agentCacheReadTokens = 0;
    agentCacheWriteTokens = 0;
    agentTotalTokens = 0;
    agentCostTotal = 0;
    agentPrefillTimeMs = 0;
    agentGenerationTimeMs = 0;
    agentAssistantMessages = 0;
    agentLastModel = "";
    lastMessageNotifyText = "";
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!agentActive) return;

    const now = Date.now();

    const agentStats: AgentStats = {
      label: agentLastModel ? `Agent ${agentLastModel}` : "Agent",

      agentTimeMs:
        agentStartedAt > 0 ? Math.max(0, now - agentStartedAt) : 0,

      prefillTimeMs: agentPrefillTimeMs,
      generationTimeMs: agentGenerationTimeMs,

      prefillTokensPerSecond: calcTps(agentInputTokens, agentPrefillTimeMs),
      generationTokensPerSecond: calcTps(
        agentOutputTokens,
        agentGenerationTimeMs,
      ),

      inputTokens: agentInputTokens,
      outputTokens: agentOutputTokens,
      cacheReadTokens: agentCacheReadTokens,
      cacheWriteTokens: agentCacheWriteTokens,

      totalTokens: agentTotalTokens,
      costTotal: agentCostTotal,
      messages: agentAssistantMessages,
      spend: agentSpend,
    };

    agentActive = false;
    resetWorkingIndicator(ctx);

    const agentNotifyText = renderAgentPlain(agentStats);

    if (lastMessageNotifyText) {
      ctx.ui.notify(`${lastMessageNotifyText}\n\n${agentNotifyText}`, "info");
    } else {
      ctx.ui.notify(agentNotifyText, "info");
    }

    appendLineEntry("agent", agentNotifyText);
  });

  // ── Provider/message lifecycle ───────────────────────────────────────────

  pi.on("before_provider_request", () => {
    requestSentAt = Date.now();
    firstTokenAt = 0;
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    firstTokenAt = 0;
    finalStats = null;
    streamedChars = 0;

    liveStats = {
      model: event.message.model,
      prefillTimeMs: 0,
      generationTimeMs: 0,
      estimatedOutputTokens: 0,
      generationTokensPerSecond: 0,
      spend: null,
      tier: null,
    };

    activeProvider = event.message.provider;
    activeModel = event.message.model;

    showWorkingIndicator(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!liveStats) return;

    const now = Date.now();

    if (firstTokenAt === 0) {
      firstTokenAt = now;

      liveStats.prefillTimeMs =
        requestSentAt > 0 ? Math.max(0, firstTokenAt - requestSentAt) : 0;
    }

    liveStats.generationTimeMs = Math.max(0, now - firstTokenAt);

    // pi normalizes every provider API (openai-completions, openai-responses,
    // anthropic, google, mistral, bedrock) into these three delta events, so
    // this works the same for cloud and local models.
    const streamEvent = event.assistantMessageEvent;
    if (
      streamEvent.type === "text_delta" ||
      streamEvent.type === "thinking_delta" ||
      streamEvent.type === "toolcall_delta"
    ) {
      streamedChars += streamEvent.delta.length;
    }

    const chars = Math.max(
      streamedChars,
      countContentChars(event.message.content),
    );

    liveStats.estimatedOutputTokens = Math.ceil(chars / 4);

    liveStats.generationTokensPerSecond = calcTps(
      liveStats.estimatedOutputTokens,
      liveStats.generationTimeMs,
    );

    const liveEstimate = estimateLiveSpend();
    liveStats.spend = liveEstimate?.amount ?? null;
    liveStats.tier = liveEstimate?.tier ?? null;

    showWorkingIndicator(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const now = Date.now();
    const usage = safeUsage(event.message);

    const effectiveFirstTokenAt = firstTokenAt || now;

    const prefillTimeMs =
      requestSentAt > 0
        ? Math.max(0, effectiveFirstTokenAt - requestSentAt)
        : 0;

    const generationTimeMs = Math.max(0, now - effectiveFirstTokenAt);

    const totalTimeMs =
      requestSentAt > 0
        ? Math.max(0, now - requestSentAt)
        : prefillTimeMs + generationTimeMs;

    finalStats = {
      model: event.message.model,

      prefillTimeMs,
      generationTimeMs,
      totalTimeMs,

      prefillTokensPerSecond: calcTps(usage.input, prefillTimeMs),
      generationTokensPerSecond: calcTps(usage.output, generationTimeMs),

      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,

      totalTokens: usage.totalTokens,
      costTotal: usage.costTotal,
      stopReason: event.message.stopReason ?? "unknown",
      spend: null,
      tier: null,
    };

    liveStats = null;
    activeProvider = event.message.provider;
    activeModel = event.message.model;

    const cost = await messageCost(activeProvider, activeModel, usage);
    finalStats.spend = cost?.amount ?? null;
    finalStats.tier = cost?.tier ?? null;
    if (cost) {
      // Raw amounts: rounding happens only when a line is rendered.
      sessionSpend = (sessionSpend ?? 0) + cost.amount;
      agentSpend = (agentSpend ?? 0) + cost.amount;
    }

    prevInputTokens = usage.input;
    prevCacheReadTokens = usage.cacheRead;
    prevCacheWriteTokens = usage.cacheWrite;

    saveState(ctx);

    addToSessionTotals(finalStats);
    addToAgentTotals(finalStats);

    pi.events.emit("token_stats:complete", {
      metrics: {
        prefillTimeMs: finalStats.prefillTimeMs,
        generationTimeMs: finalStats.generationTimeMs,
        totalTimeMs: finalStats.totalTimeMs,

        prefillTokensPerSecond: finalStats.prefillTokensPerSecond,
        tokensPerSecond: finalStats.generationTokensPerSecond,

        inputTokens: finalStats.inputTokens,
        outputTokens: finalStats.outputTokens,
        cacheReadTokens: finalStats.cacheReadTokens,
        cacheWriteTokens: finalStats.cacheWriteTokens,

        sessionTurns: sessionTotals.turns,
        sessionInputTokens: sessionTotals.inputTokens,
        sessionOutputTokens: sessionTotals.outputTokens,
        sessionCacheReadTokens: sessionTotals.cacheReadTokens,
        sessionCacheWriteTokens: sessionTotals.cacheWriteTokens,
        sessionTotalTokens: sessionTotals.totalTokens,
        sessionCostTotal: sessionTotals.costTotal,

        agentMessages: agentAssistantMessages,
        agentInputTokens,
        agentOutputTokens,
        agentCacheReadTokens,
        agentCacheWriteTokens,
        agentTotalTokens,
        agentCostTotal,
      },
      modelId: finalStats.model,
    });

    resetWorkingIndicator(ctx);

    if (config?.providers?.[activeProvider]?.balance?.showInMessages) {
      await refreshBalance(ctx);
    } else {
      setStatusLine(ctx);
      void refreshBalance(ctx);
    }

    lastMessageNotifyText = renderFinalPlain(finalStats);
    ctx.ui.notify(lastMessageNotifyText, "info");
    appendLineEntry("message", lastMessageNotifyText);
  });

  // ── Session lifecycle ────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    liveStats = null;
    finalStats = null;
    lastMessageNotifyText = "";

    loadConfig(ctx);
    balances.clear();
    fxRates.clear();

    activeProvider = "";
    activeModel = "";
    sessionSpend = null;
    agentSpend = null;
    prevInputTokens = 0;
    prevCacheReadTokens = 0;
    prevCacheWriteTokens = 0;

    loadPersistedState(ctx);

    activeProvider = ctx.model?.provider ?? "";
    activeModel = ctx.model?.id ?? "";

    resetSessionTotals();
    resetAgentTotals();

    resetWorkingIndicator(ctx);
    setStatusLine(ctx);
    void refreshBalance(ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    liveStats = null;
    lastMessageNotifyText = "";
    resetWorkingIndicator(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    saveState(ctx);
    liveStats = null;
    finalStats = null;
    agentActive = false;
    resetWorkingIndicator(ctx);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // ── Totals ───────────────────────────────────────────────────────────────

  function resetSessionTotals() {
    sessionTotals.turns = 0;
    sessionTotals.inputTokens = 0;
    sessionTotals.outputTokens = 0;
    sessionTotals.cacheReadTokens = 0;
    sessionTotals.cacheWriteTokens = 0;
    sessionTotals.totalTokens = 0;
    sessionTotals.costTotal = 0;
  }

  function addToSessionTotals(stats: FinalStats) {
    sessionTotals.turns += 1;
    sessionTotals.inputTokens += stats.inputTokens;
    sessionTotals.outputTokens += stats.outputTokens;
    sessionTotals.cacheReadTokens += stats.cacheReadTokens;
    sessionTotals.cacheWriteTokens += stats.cacheWriteTokens;
    sessionTotals.totalTokens += stats.totalTokens;
    sessionTotals.costTotal += stats.costTotal;
  }

  function resetAgentTotals() {
    agentStartedAt = 0;
    agentActive = false;

    agentInputTokens = 0;
    agentOutputTokens = 0;
    agentCacheReadTokens = 0;
    agentCacheWriteTokens = 0;
    agentTotalTokens = 0;
    agentCostTotal = 0;
    agentPrefillTimeMs = 0;
    agentGenerationTimeMs = 0;
    agentAssistantMessages = 0;
    agentLastModel = "";
  }

  function addToAgentTotals(stats: FinalStats) {
    if (!agentActive) return;

    agentAssistantMessages += 1;
    agentLastModel = stats.model;

    agentInputTokens += stats.inputTokens;
    agentOutputTokens += stats.outputTokens;
    agentCacheReadTokens += stats.cacheReadTokens;
    agentCacheWriteTokens += stats.cacheWriteTokens;
    agentTotalTokens += stats.totalTokens;
    agentCostTotal += stats.costTotal;

    agentPrefillTimeMs += stats.prefillTimeMs;
    agentGenerationTimeMs += stats.generationTimeMs;
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function formatSpend(
    value: number,
    tier: "peak" | "off-peak" | null,
    approximate = false,
  ): string {
    const money = `${approximate ? "~" : ""}${formatMoney(value, config?.currency ?? "EUR")}`;
    return tier ? `${money} ${tier}` : money;
  }

  /** Small spends render as cents; `withFull` adds the 3-decimal currency value. */
  function formatSpendCents(value: number, withFull: boolean, approximate = false): string {
    const currency = config?.currency ?? "EUR";
    const prefix = approximate ? "~" : "";

    if (value >= CENTS_THRESHOLD) return `${prefix}${formatMoney(value, currency)}`;

    const cents = `${prefix}${formatCents(value)}`;
    return withFull ? `${cents} (${formatMoney(value, currency)})` : cents;
  }

  function formatSpendLine(
    value: number,
    withFull: boolean,
    approximate: boolean,
    tier: "peak" | "off-peak" | null,
  ): string {
    const amount = formatSpendCents(value, withFull, approximate);
    return tier ? `${amount} ${tier}` : amount;
  }

  /** Balance for notify lines, or "" when `balance.showInMessages` is off. */
  function lineBalance(): string {
    const providerConfig = config?.providers?.[activeProvider];
    const balance = balances.get(activeProvider);
    if (!config || !providerConfig?.balance?.showInMessages || !balance) return "";

    const shown = providerConfig.balance.currency || balance.currency;
    const primary = convert(balance.total, balance.currency, shown);
    if (primary == null) return "";

    const secondary = convert(primary, shown, config.currency);
    const label = providerConfig.balance.emoji ? `${providerConfig.balance.emoji} ` : "bal ";
    const value = `${label}${formatMoney(primary, shown, 2)}`;

    return secondary == null
      ? value
      : `${value} (${formatMoney(secondary, config.currency, 2)})`;
  }

  function renderFinalPlain(stats: FinalStats): string {
    let spendSuffix = "";
    if (stats.spend != null) {
      spendSuffix = ` · ${formatSpendLine(stats.spend, true, false, stats.tier)}`;
    }

    const balance = lineBalance();
    if (balance) spendSuffix += ` · ${balance}`;

    return [
      stats.model,
      "✓",
      formatDuration(stats.totalTimeMs),
      `(↑${formatDuration(stats.prefillTimeMs)} + ↓${formatDuration(
        stats.generationTimeMs,
      )})`,
      "·",
      `↑${formatTokens(stats.inputTokens)} @ ${formatRateNumber(
        stats.prefillTokensPerSecond,
      )}/s`,
      "·",
      `↓${formatTokens(stats.outputTokens)} @ ${formatRateNumber(
        stats.generationTokensPerSecond,
      )}/s`,
      "·",
      `Cache R${formatTokens(stats.cacheReadTokens)} W${formatTokens(
        stats.cacheWriteTokens,
      )}${spendSuffix}`,
    ].join(" ");
  }

  function renderAgentPlain(stats: AgentStats): string {
    const suffixes = [
      stats.spend == null ? "" : formatSpendCents(stats.spend, true),
      lineBalance(),
      stats.messages > 1 ? `${stats.messages} responses` : "",
    ].filter(Boolean);
    const suffix = suffixes.length > 0 ? ` · ${suffixes.join(" · ")}` : "";

    return [
      stats.label,
      "✓",
      formatDuration(stats.agentTimeMs),
      `(↑${formatDuration(stats.prefillTimeMs)} + ↓${formatDuration(
        stats.generationTimeMs,
      )})`,
      "·",
      `↑${formatTokens(stats.inputTokens)} @ ${formatRateNumber(
        stats.prefillTokensPerSecond,
      )}/s`,
      "·",
      `↓${formatTokens(stats.outputTokens)} @ ${formatRateNumber(
        stats.generationTokensPerSecond,
      )}/s`,
      "·",
      `Cache R${formatTokens(stats.cacheReadTokens)} W${formatTokens(
        stats.cacheWriteTokens,
      )}${suffix}`,
    ].join(" ");
  }

  function renderLivePlain(stats: LiveStats): string {
    const totalMs =
      stats.prefillTimeMs > 0
        ? stats.prefillTimeMs + stats.generationTimeMs
        : stats.generationTimeMs;

    const spendParts =
      stats.spend == null
        ? []
        : ["·", formatSpendCents(stats.spend, false, true)];

    return [
      stats.model,
      "…",
      formatDuration(totalMs),
      `(↑${formatDuration(stats.prefillTimeMs)} + ↓${formatDuration(
        stats.generationTimeMs,
      )})`,
      "·",
      `↓${formatTokens(stats.estimatedOutputTokens)} @ ${formatRateNumber(
        stats.generationTokensPerSecond,
      )}/s`,
      ...spendParts,
    ].join(" ");
  }

  function showWorkingIndicator(ctx: ExtensionContext) {
    if (!ctx.hasUI || !liveStats) return;

    ctx.ui.setWorkingIndicator({
      frames: [renderLivePlain(liveStats)],
      intervalMs: 250,
    } as any);
  }

  function resetWorkingIndicator(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setWorkingIndicator(undefined as any);
  }
}
