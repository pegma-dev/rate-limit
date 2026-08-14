# Contributing

Read [AGENTS.md](AGENTS.md) before changing the package. Pull requests must
pass the complete gate on Node.js 22 and 24:

```sh
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
```

`pnpm test` starts Azurite. Durable behavior, especially contention and
read-only refusal, must be verified against that real backend.
