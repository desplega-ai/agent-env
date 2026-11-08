# Contributing

Use Node.js 22 or newer and a running Docker Engine with Docker Compose.
Clone the repository and create a branch for your changes.

```sh
git clone https://github.com/desplega-ai/agent-env.git
cd agent-env
npm run check
npm test
```

The package has no npm dependencies and requires no build step.
The tests invoke the public CLI and use real services.
Do not add unit tests, provider mocks, or tests that import application internals.
Use an isolated state directory, unique resources, and cleanup in every test.

Use `.env.example` for variable names and harmless examples.
Keep real credentials in ignored dotenv files or the private environment store.

See [release instructions](docs/releases.md) for CI commands, version changes, and publishing.
Use the [Agent Swarm example](docs/agent-swarm.md) when a change affects a complete development stack.
