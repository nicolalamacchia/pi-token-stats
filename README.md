# pi-token-stats

Live token and throughput stats for [pi](https://pi.dev).

While the model is streaming, pi's working indicator shows estimated output tokens and generation speed:

```text
IBM/Granite4-7B-A1B-H … 17.9s (↑15.6s + ↓2.3s) · ↓2.4k @ 138.2/s
```

When the message finishes, a notification shows the provider's finalized usage:

```text
IBM/Granite4-7B-A1B-H ✓ 17.9s (↑15.6s + ↓2.3s) · ↑9.8k @ 625.5/s · ↓114 @ 49.9/s · Cache R2.0k W0
```

At the end of an agent run, a second notification aggregates every response in the run:

```text
Agent IBM/Granite4-7B-A1B-H ✓ 20.1s (↑15.6s + ↓2.3s) · ↑9.8k @ 625.5/s · ↓114 @ 49.9/s · Cache R2.0k W0 · 3 responses
```

## Reading the stats

- `✓` / `…` — finalized message / live generation
- `17.9s` — total wall time
- `(↑15.6s + ↓2.3s)` — prefill (time to first token) + generation time
- `↑9.8k @ 625.5/s` — input tokens and prefill throughput
- `↓114 @ 49.9/s` — output tokens and generation throughput
- `Cache R2.0k W0` — cache read and cache write tokens

Live output tokens are estimated from streamed characters (about 4 chars per token) and include text, thinking, and tool-call arguments. Finalized numbers come from the provider's usage report.

## Balance and spend

When the active provider is configured, the footer line keeps the remaining
API balance and the session spend:

```text
💰 deepseek $1.67 (€1.59) · 💸 €0.010 · off-peak
```

- `💰` — optional, set `balance.emoji`; hidden when absent
- `$1.67` — balance in `balance.currency` (USD), rounded to 2 decimals. If the
  API reports another currency, the value is converted into the configured one
  with live ECB rates.
- `(€1.59)` — the same balance in the display `currency`, converted with the
  same rates (cached for `fxCacheMinutes`, default 60)
- `💸` — spend of the whole session, in the display currency; set
  `balance.spentLabel` to any text (e.g. `"spent"`) to replace the emoji
- `peak` / `off-peak` — current pricing tier
- color — `accent` normally, `warning` below `balance.low`, `error` below
  `balance.critical` (both in `balance.currency`)

The footer is populated at session start, before the first message: it shows
the cached balance from the state file (when persistence is on) and refreshes
it from the API right away. Spend survives reloads and resumes of the same
session only.

Balance uses 2 decimals (tiny values print as `<0.01`); spend uses 3 decimals
(tiny values print as `<0.001`). Both round.

The line refreshes after every assistant message.

Message and agent lines carry their own spend, in the display currency:

```text
deepseek-flash … 4.1s (↑2.9s + ↓1.2s) · ↓512 @ 126.8/s · ~0.03¢
deepseek-flash ✓ 4.4s (↑2.9s + ↓1.5s) · ↑42.1k @ 14.5k/s · ↓512 @ 341.3/s · Cache R38.0k W0 · 0.07¢ (€0.001) off-peak · 💰 $1.68 (€1.50)
Agent deepseek-flash ✓ 9.0s (↑5.8s + ↓3.2s) · ↑84.2k @ 14.5k/s · ↓1.0k @ 318.7/s · Cache R76.0k W0 · 0.07¢ (€0.001) · 💰 $1.68 (€1.50)
```

- live line — `~` estimate from the previous prefill plus the output streamed
  so far (input usage is only known when the message ends)
- message line — exact spend of that message
- agent line — exact spend of the whole agent run
- `💰 $1.68 (€1.50)` — balance after the message, when
  `balance.showInMessages` is on; keeps a balance history in the transcript
- `peak` / `off-peak` — time tier applied to the message price

Spend below 0.1 in the display currency is rendered in cents (`0.07¢`); the
message line adds the currency value in parentheses (`0.07¢ (€0.001)`), the
live line shows cents only. Larger values use the currency format.

Spend is computed from the provider's token usage (cache read, cache miss,
output) and the prices in the config, never from pi's own cost estimate, so
time-of-day discounts apply.

## Configuration

Balance and spend are opt-in. The extension reads `~/.pi/token-stats.json`
(override with `PI_TOKEN_STATS_CONFIG`). The file is read at session start, so
run `/reload` after editing it.

```json
{
  "currency": "EUR",
  "fxCacheMinutes": 60,
  "persistence": { "enabled": true },
  "providers": {
    "deepseek": {
      "balance": {
        "url": "https://api.deepseek.com/user/balance",
        "keyName": "DEEPSEEK_API_KEY",
        "envFile": "~/.pi/keys/ds.env",
        "currency": "USD",
        "low": 2,
        "critical": 1,
        "emoji": "💰",
        "spentLabel": "💸",
        "showInMessages": true
      },
      "spending": {
        "enabled": true,
        "currency": "USD",
        "offPeakMultiplier": 0.5,
        "peakWeekdays": ["Mon", "Tue", "Wed", "Thu", "Fri"],
        "peakWindowsUtc": [["01:00", "04:00"], ["06:00", "10:00"]],
        "holidays": ["2026-01-01", "2026-02-15"],
        "models": {
          "deepseek-flash": { "cacheHit": 0.006, "cacheMiss": 0.3, "output": 1.2 },
          "deepseek-v4-pro": { "cacheHit": 0.044, "cacheMiss": 1.32, "output": 3.96 }
        }
      }
    }
  }
}
```

Provider keys match `message.provider`. Prices are per 1M tokens at the peak
rate; `offPeakMultiplier` is applied outside peak hours. Model keys match a
model id exactly or as a substring (longest key wins), so aliases such as
`deepseek-v4-flash` can map to the same prices. Without a matching price the
spend part is hidden.

The API key is read from `envFile` (first `KEY=VALUE` match) and falls back to
the process environment. `balance.currency` is the currency shown first
(`USD`); the display `currency` is the second value. `balance.low` and
`balance.critical` set the warning and error thresholds. `balance.emoji` adds
an optional emoji before the provider name in the footer, and
`balance.spentLabel` sets the label before the session spend (default `💸`).
`balance.showInMessages` appends the balance to the message and agent lines;
the balance is fetched after the message finishes, so each line records the
value right after that response.

`persistence` is off by default. When enabled, the extension keeps the
session spend and the last balance per provider in
`~/.pi/token-stats-state.json` (override with `persistence.path`), written on
every message and on shutdown. Sessions idle for more than 30 days are pruned;
the file keeps at most 100 sessions.

DeepSeek prices and peak windows are from
[api-docs.deepseek.com](https://api-docs.deepseek.com/quick_start/pricing):
peak is 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday, excluding Chinese
public holidays. DeepSeek reports the balance in the account currency (USD for
international accounts), so the CNY figure is the converted equivalent unless
the API already returns CNY.

## Behaviour

- No persistence, commands, widgets, or custom renderer.
- Works with every provider pi normalizes (OpenAI, Anthropic, Google, Mistral, Bedrock, local models).
- Live progress is only shown when the UI is available.
- Emits a `token_stats:complete` event on pi's event bus after every assistant message, with message, session, and agent totals. Other extensions can subscribe to it:

```ts
pi.events.on("token_stats:complete", ({ metrics, modelId }) => {
  console.log(modelId, metrics.tokensPerSecond, metrics.sessionTotalTokens);
});
```

## Install

```bash
pi install git:github.com/nicolalamacchia/pi-token-stats
# or, for one invocation
pi -e ./extensions/token-stats.ts
```

The extension can also be copied directly into `~/.pi/agent/extensions/`.

## License

MIT
