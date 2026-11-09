import { randomUUID } from 'node:crypto';
import { acknowledgeAllocation, settledAllocation } from '../allocation-command.mjs';

export function ownership(handle) {
  return { 'agent-env.owner': handle.spec.owner, 'agent-env.instance': handle.spec.name, 'agent-env.record': handle.allocation.record };
}

async function listings(provider, handle, resources) {
  return new Map(await Promise.all([...new Set(resources.map(resource => resource.kind))].map(async kind => {
    const output = await provider.docker(handle.spec, [kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '--format', kind === 'image' ? '{{.Repository}}:{{.Tag}}' : kind === 'container' ? '{{.Names}}' : '{{.Name}}']);
    return [kind, new Set(output.split('\n'))];
  })));
}

async function inspect(provider, handle, resource, names) {
  const { kind, name } = resource;
  if (!names.get(kind).has(name)) return null;
  return JSON.parse(await provider.docker(handle.spec, [kind, 'inspect', name]))[0];
}

function refuse(resource) {
  throw new Error(`Refusing foreign ${resource.kind} ${resource.name}. Resource ownership does not match the saved instance.`);
}

// Persist this complete resource list before the provider can allocate anything.
export async function planAllocation(provider, handle, resources) {
  handle.allocation = { record: handle.allocation?.record ?? randomUUID(), resources };
  const names = await listings(provider, handle, resources);
  for (const resource of resources) {
    const info = await inspect(provider, handle, resource, names);
    if (!info) continue;
    const labels = info.Config?.Labels ?? info.Labels ?? {};
    // Retained data, forks, and snapshot imports can predate instance labels.
    // Pin their exact identity before allocation. Never adopt existing compute.
    if (!['volume', 'image'].includes(resource.kind) || labels['agent-env.owner'] !== handle.spec.owner ||
        labels['agent-env.instance'] && labels['agent-env.instance'] !== handle.spec.name ||
        labels['com.docker.compose.project'] && labels['com.docker.compose.project'] !== provider.prefix(handle.spec)) refuse(resource);
    resource.existingId = resource.kind === 'volume' ? info.CreatedAt : info.Id;
  }
}

export async function verifyAllocation(provider, handle, resources = handle.allocation.resources, options = {}) {
  await settledAllocation(handle, options);
  const found = [];
  const names = await listings(provider, handle, resources);
  for (const resource of resources) {
    const info = await inspect(provider, handle, resource, names);
    if (!info) continue;
    const labels = info.Config?.Labels ?? info.Labels ?? {};
    if (resource.existingId) {
      const sameIdentity = (resource.kind === 'volume' ? info.CreatedAt : info.Id) === resource.existingId;
      const rebuilt = resource.kind === 'image' && Object.entries(ownership(handle)).every(([key, value]) => labels[key] === value);
      if ((!sameIdentity && !rebuilt) || labels['agent-env.owner'] !== handle.spec.owner) refuse(resource);
    } else {
      const expected = resource.kind === 'volume' && handle.project
        ? { 'agent-env.owner': handle.spec.owner, 'agent-env.instance': handle.spec.name, 'com.docker.compose.project': handle.project }
        : ownership(handle);
      if (Object.entries(expected).some(([key, value]) => labels[key] !== value)) refuse(resource);
    }
    found.push(resource);
  }
  if (handle.project) {
    // Compose must not adopt or remove unexpected containers from this project.
    const output = await provider.docker(handle.spec, ['container', 'ls', '-a', '--filter', `label=com.docker.compose.project=${handle.project}`, '--format', '{{.Names}}']);
    for (const name of output.split('\n').filter(Boolean)) {
      if (!handle.allocation.resources.some(resource => resource.kind === 'container' && resource.name === name)) refuse({ kind: 'container', name });
    }
  }
  return found;
}

export async function acceptUncertainAllocation(provider, handle) {
  await verifyAllocation(provider, handle, handle.allocation.resources, { allowUncertain: true });
  await acknowledgeAllocation(handle);
}

export async function removeAllocation(provider, handle, { purge = false, failed = false, computeOnly = false } = {}) {
  // Verify the complete set before the first destructive operation.
  const resources = await verifyAllocation(provider, handle);
  for (const kind of ['container', 'network', 'volume', 'image']) {
    for (const resource of resources.filter(item => item.kind === kind)) {
      if (['volume', 'image'].includes(kind) && (computeOnly || !purge || failed && resource.existingId)) continue;
      await provider.docker(handle.spec, [kind, 'rm', ...(kind === 'container' ? [purge || failed || computeOnly ? '-fv' : '-f'] : []), resource.name]);
    }
  }
  await verifyAllocation(provider, handle);
}
