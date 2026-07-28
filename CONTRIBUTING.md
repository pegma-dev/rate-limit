# Contributing

Read [AGENTS.md](AGENTS.md) before changing the package. Pull requests must
pass the complete gate on Node.js 22 and 24:

```sh
npm ci
npm run format:check
npm run check
npm test
```

`npm test` starts Azurite. Durable behavior, especially contention and
read-only refusal, must be verified against that real backend.
