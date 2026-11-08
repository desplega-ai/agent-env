# Project rules

- Keep all tests end to end. Do not add unit tests or mock providers.
- Invoke the installed CLI in tests. Use real Docker, Compose, SSH, HTTP, and storage services for integration coverage.
- Keep ordinary CI independent of private credentials and paid cloud resources.
- Use isolated names, ports, and state for tests. Remove only resources that the test created.
- Treat environment values as private. Do not add real credentials to fixtures, reports, or snapshots.
- Verify changes in the Agent Swarm example when they affect startup, environment files, routing, or persistence.
- A version bump merged into the default branch triggers the release workflow after CI passes.
