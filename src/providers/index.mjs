import { DockerProvider } from './docker.mjs';
import { SandboxProvider } from './sandbox.mjs';
import { ComposeProvider } from './compose.mjs';
import { DevcontainerProvider } from './devcontainer.mjs';
import { E2BProvider } from './e2b.mjs';
const providers = new Map([['docker', new DockerProvider()], ['compose', new ComposeProvider()], ['sandbox', new SandboxProvider()], ['devcontainer', new DevcontainerProvider()], ['e2b', new E2BProvider()]]);
export function providerFor(spec) {
  const provider = providers.get(spec.provider);
  if (!provider) throw new Error(`Provider ${spec.provider} is not installed. Available providers: ${[...providers.keys()].join(', ')}.`);
  return provider;
}

export async function disposeProviders() {
  await Promise.all([...providers.values()].map(provider => provider.dispose?.()));
}
