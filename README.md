# free-model-aggregator

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/romdhoncom/free-model-aggregator/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/romdhoncom/free-model-aggregator/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

One server that speaks both the OpenAI Chat Completions and the Anthropic Messages API, in JSON and in
server-sent events, over ten simulated free-tier providers: it reads their catalogs, routes every request
to the best free model that meets it, fails over when a provider refuses, and reports the catalog it read.
No dependencies, no network but the env.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8580 MAKEFUN_PROMPT_FILE=./input/prompt.txt node main.ts
node main.ts --list   # print the catalog document it registers
node test/run-trial.mjs --kit ../free-model-aggregator-01-kit   # one practice trial, scored locally
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=j1qv1zx6&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards</sub>
