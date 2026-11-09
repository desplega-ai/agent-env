# Dev Container examples

Run each example from this directory. The workspace includes the shared server file.
Use a distinct instance name for each example.

```sh
cd image
agent-env up --name dc-image
agent-env exec dc-image -- node --version
agent-env down dc-image
agent-env up dc-image
agent-env rm dc-image --purge
```

Replace `image` with `dockerfile` or `compose` for the other definitions.
The Dockerfile example creates `/image-marker` during its build.
The Compose example retains `/data` across `down` and ordinary `rm`.
The provider replaces the Compose host port with an ephemeral loopback port.

The native `postStartCommand` starts the HTTP service.
No `agent-env.json` service command or image is necessary.
The image and Dockerfile examples require the common parent directory as their workspace.
Use the workspace mount from the configuration in these examples.

See [Dev Container support](../../docs/devcontainers.md) for routes and integration details.
