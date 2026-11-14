# free-model-aggregator

One Node 22 server (`main.ts`) that serves an OpenAI- and an Anthropic-compatible API over ten simulated
free-tier model providers, for make.fun's "The best free AI model aggregator" bounty. Standard library
only; TypeScript runs directly under Node 22's type stripping.

## Status

Updated 2026-11-14: works. The kit's own env and scorer give score 99 of 100 on practice trials 0, 1 and
2 (quality 99, served 100, wire 100, failover 100, catalog 100, 20/20 requests valid). Open.

## Run

- A trial: `MAKEFUN_ENV_URL=<env> MAKEFUN_PROMPT_FILE=<brief> node main.ts`. The server probes each
  provider's catalog route, registers the catalog with the env, serves the client and exits 0 when
  `GET $MAKEFUN_ENV_URL/work` says done.
- `node main.ts --list` prints the catalog document and exits without a server.
- `node test/run-trial.mjs --kit <unpacked kit> [--trial 1]` runs one practice trial against the kit's
  env and scores it with the kit's scorer, which is how the score above was measured.

## Map

- `main.ts`: the server, the routing and failover policy, register, the work poll, `--list`.
- `lib/brief.ts`: reads the three JSON documents out of the brief.
- `lib/catalog.ts`: probes providers, builds the catalog, ranks the free candidates for a request.
- `lib/wire.ts`: rewrites a request into each provider wire and each answer back into the client's wire,
  including both event streams.

## Decisions

- Every provider call is made non-streamed and the client's stream is written here, because the client
  checks the event order of what it receives, not what the provider sent.
- The brief carries no per-trial budget, so a provider is retired after three refusals in a row and the
  same candidate is retried once before the ranking moves on: the failures that are schedules (two calls
  in a row) still answer, and an exhausted provider stops costing calls.
- Nothing reads the clock or draws randomness, so a replay leaves the same state export.
- The kit's `grade-local --driver process` cannot start its env on Windows (its forwarder path check
  rejects a backslash), which is why `test/run-trial.mjs` runs the same three pieces itself.
