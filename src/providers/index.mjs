import { DockerProvider } from './docker.mjs';
const providers = new Map([['docker', new DockerProvider()]]);
export function providerFor(spec) {
  const provider = providers.get(spec.provider);
  if (!provider) throw new Error(`Provider ${spec.provider} is not installed. Available providers: ${[...providers.keys()].join(', ')}.`);
  return provider;
}

export async function disposeProviders() {
  await Promise.all([...providers.values()].map(provider => provider.dispose?.()));
}
