# pi-token-stats

Live token and throughput stats for [pi](https://pi.dev).

While the model is streaming, pi's working indicator shows estimated output tokens and generation speed:

```
IBM/Granite4-7B-A1B-H … 17.9s (↑15.6s + ↓2.3s) · ↓2.4k @ 138.2/s
```

When the message finishes, a notification shows the provider's finalized usage:

```
IBM/Granite4-7B-A1B-H ✓ 17.9s (↑15.6s + ↓2.3s) · ↑9.8k @ 625.5/s · ↓114 @ 49.9/s · Cache R2.0k W0
```

At the end of an agent run, a second notification aggregates every response in the run:

```
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
