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
 *
 * Message format:
 * IBM/Granite4-7B-A1B-H ✓ 17.9s (↑15.6s + ↓2.3s) · ↑9.8k @ 625.5/s · ↓114 @ 49.9/s · Cache R2.0k W0
 *
 * Agent-end notify format:
 * <last message stats>
 *
 * Agent ✓ 20.1s (↑15.6s + ↓2.3s) · ↑9.8k @ 625.5/s · ↓114 @ 49.9/s · Cache R2.0k W0
 *
 * Usage:
 * pi -e ./token-stats.ts
 */

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

// ─── Extension ───────────────────────────────────────────────────────────────

export default function tokenStatsExtension(pi: ExtensionAPI) {
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

  // ── Agent lifecycle ──────────────────────────────────────────────────────

  pi.on("agent_start", (_event, _ctx) => {
    agentStartedAt = Date.now();
    agentActive = true;

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
    };

    agentActive = false;
    resetWorkingIndicator(ctx);

    const agentNotifyText = renderAgentPlain(agentStats);

    if (lastMessageNotifyText) {
      ctx.ui.notify(`${lastMessageNotifyText}\n\n${agentNotifyText}`, "info");
    } else {
      ctx.ui.notify(agentNotifyText, "info");
    }
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
    };

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

    showWorkingIndicator(ctx);
  });

  pi.on("message_end", (event, ctx) => {
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
    };

    liveStats = null;

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

    lastMessageNotifyText = renderFinalPlain(finalStats);
    ctx.ui.notify(lastMessageNotifyText, "info");
  });

  // ── Session lifecycle ────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    liveStats = null;
    finalStats = null;
    lastMessageNotifyText = "";

    resetSessionTotals();
    resetAgentTotals();

    resetWorkingIndicator(ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    liveStats = null;
    lastMessageNotifyText = "";
    resetWorkingIndicator(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    liveStats = null;
    finalStats = null;
    agentActive = false;
    resetWorkingIndicator(ctx);
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

  function renderFinalPlain(stats: FinalStats): string {
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
      )}`,
    ].join(" ");
  }

  function renderAgentPlain(stats: AgentStats): string {
    const messageSuffix =
      stats.messages > 1 ? ` · ${stats.messages} responses` : "";

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
      )}${messageSuffix}`,
    ].join(" ");
  }

  function renderLivePlain(stats: LiveStats): string {
    const totalMs =
      stats.prefillTimeMs > 0
        ? stats.prefillTimeMs + stats.generationTimeMs
        : stats.generationTimeMs;

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
