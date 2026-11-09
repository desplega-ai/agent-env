import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import http from 'node:http';
import { home } from '../paths.mjs';
import { run, delay, reachable } from '../system.mjs';
import { credentialValues, redactEnvironment, sensitiveValuesForSpec } from '../environments.mjs';
import { routeProtocol } from '../route-protocol.mjs';

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const labelKey = 'agent-env.devcontainer';
const portNumber = value => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535;
function dependencies() {
  const require = createRequire(import.meta.url);
  try {
    return { executable: require.resolve('@devcontainers/cli/devcontainer.js'), parser: require('jsonc-parser') };
  } catch { throw new Error('Reinstall agent-env with its @devcontainers/cli and jsonc-parser dependencies.'); }
}
function localOnly(spec) {
  if (spec.host || spec.cloud || spec.sshConfig) throw new Error('Dev Containers support local Docker only. Remove the SSH or cloud target.');
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) throw new Error('Dev Containers require a local Docker socket.');
}
function environment(spec, project) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_'))),
    ...spec.env, ...(project ? { COMPOSE_PROJECT_NAME: project } : {}) };
}
async function docker(spec, args, project) {
  localOnly(spec);
  try { return await run('docker', args, { cwd: spec.cwd, env: environment(spec, project), errorStdout: false, combined: args[0] === 'logs' }); }
  catch (error) { throw Object.assign(new Error(`Docker ${args[0]} failed. Check Docker and instance status.`), { exitCode: error.exitCode ?? 1 }); }
}
async function cli(spec, command, args = [], handle) {
  localOnly(spec);
  const executable = dependencies().executable;
  const labels = handle ? [`${labelKey}=${handle.record}`, `agent-env.owner=${spec.owner}`] : [`agent-env.resolve=${digest(spec.cwd)}`];
  try {
    return await run(process.execPath, [executable, command, '--workspace-folder', spec.cwd,
      '--config', spec.devcontainer.config, ...labels.flatMap(label => ['--id-label', label]),
      ...(handle ? ['--override-config', handle.runtimeFile, '--user-data-folder', join(handle.runtimeDirectory, 'cli')] : []),
      ...(['up', 'exec'].includes(command) ? Object.entries(spec.env ?? {}).flatMap(([key, value]) => ['--remote-env', `${key}=${value}`]) : []),
      ...args], { cwd: spec.cwd, env: environment(spec, handle?.project), combined: command === 'exec' });
  } catch (error) {
    if (command === 'exec') throw Object.assign(new Error(redactEnvironment(error.message, sensitiveValuesForSpec(spec))), { exitCode: error.exitCode ?? 1 });
    // Structured CLI diagnostics can contain private environment values.
    throw Object.assign(new Error(`Dev Container ${command} failed. Check the configuration, lifecycle hooks, and Docker status.`), { exitCode: error.exitCode ?? 1 });
  }
}
export async function detectDevcontainerConfig(cwd) {
  for (const file of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
    try { if ((await stat(resolve(cwd, file))).isFile()) return resolve(cwd, file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return undefined;
}
function routeMetadata(configuration, routes) {
  const primary = configuration.service ?? 'workspace';
  if (configuration.forwardPorts !== undefined && !Array.isArray(configuration.forwardPorts)) throw new Error('Dev Container forwardPorts must contain an array.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(primary)) throw new Error('The Dev Container workspace service name is invalid.');
  const services = { [primary]: { devcontainerService: primary, internal: true } };
  if (routes !== undefined && (!routes || typeof routes !== 'object' || Array.isArray(routes))) throw new Error('Dev Container routes must map names to route definitions.');
  const entries = routes === undefined ? (configuration.forwardPorts ?? []).map((value, index) => {
    const match = /^(?:([a-zA-Z0-9_.-]+):)?([0-9]+)$/.exec(String(value));
    if (!match) throw new Error('Use numeric forwardPorts or service:port entries.');
    const service = match[1] ?? primary, target = Number(match[2]);
    return [index === 0 && service === primary ? primary : `port-${target}`, { service, target, port: target }];
  }) : Object.entries(routes);
  const publicPorts = new Set(), targets = new Set(), aliases = new Set();
  for (const [name, route] of entries) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(name) || !route || typeof route !== 'object') throw new Error('Use valid route names and route objects.');
    const service = route.service ?? primary, target = Number(route.target ?? route.containerPort ?? route.port), port = Number(route.port ?? target);
    const protocol = routeProtocol(target, route.protocol, configuration.portsAttributes?.[target]?.protocol ?? configuration.otherPortsAttributes?.protocol);
    if (!portNumber(target) || !portNumber(port) || !['http', 'tcp'].includes(protocol)) throw new Error('Each route requires valid ports and an http or tcp protocol.');
    if (publicPorts.has(port) || targets.has(`${service}:${target}`) || aliases.has(name) || name === primary && service !== primary) throw new Error('Dev Container routes must use distinct names, public ports, and targets.');
    publicPorts.add(port); targets.add(`${service}:${target}`); aliases.add(name);
    services[name] = { devcontainerService: service, containerPort: target, port, protocol, waitForPort: routes !== undefined };
  }
  return { services, primaryService: primary };
}
async function composeModel(spec, configuration, project) {
  const files = (Array.isArray(configuration.dockerComposeFile) ? configuration.dockerComposeFile : [configuration.dockerComposeFile]).map(file => resolve(dirname(spec.devcontainer.config), file));
  if (!files.length) throw new Error('Specify explicit Docker Compose files in the Dev Container configuration.');
  return JSON.parse(await docker(spec, ['compose', '--project-directory', dirname(files[0]), ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json'], project));
}
async function composeHash(spec, configuration) {
  return configuration.dockerComposeFile ? digest(JSON.stringify(await composeModel(spec, configuration, 'agent-env-config'))) : undefined;
}
export async function resolveDevcontainerSpec(spec) {
  localOnly(spec);
  const config = spec.devcontainer?.config ? resolve(spec.cwd, spec.devcontainer.config) : await detectDevcontainerConfig(spec.cwd);
  if (!config) throw new Error('No Dev Container configuration exists. Specify devcontainer.config or create .devcontainer/devcontainer.json.');
  const errors = [];
  const configuration = dependencies().parser.parse(await readFile(config, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length || !configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('The Dev Container configuration must contain a valid JSONC object.');
  const resolved = { ...spec, provider: 'devcontainer', devcontainer: { ...spec.devcontainer, config: await realpath(config), configuration } };
  const normalized = JSON.parse(await cli(resolved, 'read-configuration')).configuration;
  if (!normalized.image && !normalized.build && !normalized.dockerFile && !normalized.dockerComposeFile) throw new Error('Define a Dev Container image, Dockerfile, or Docker Compose configuration.');
  const model = normalized.dockerComposeFile ? await composeModel(resolved, normalized, 'agent-env-config') : undefined;
  if (model) resolved.devcontainer.composeHash = digest(JSON.stringify(model));
  return { ...resolved, sensitiveValues: [...new Set([...(spec.sensitiveValues ?? []), ...credentialValues(normalized.containerEnv), ...credentialValues(normalized.remoteEnv),
    ...Object.values(model?.services ?? {}).flatMap(service => credentialValues(service.environment))])],
    ...routeMetadata(normalized, spec.devcontainer?.routes) };
}
function labels(handle) {
  return { [labelKey]: handle.record, 'agent-env.owner': handle.spec.owner, 'agent-env.instance': handle.spec.name };
}
function owns(handle, info) {
  const found = info.Config?.Labels ?? info.Labels ?? {};
  return Object.entries(labels(handle)).every(([key, value]) => found[key] === value);
}
function mountObject(mount) {
  if (typeof mount !== 'string') return structuredClone(mount);
  const parts = Object.fromEntries(mount.split(',').map(part => { const at = part.indexOf('='); return [part.slice(0, at), part.slice(at + 1)]; }));
  return { ...parts, source: parts.source ?? parts.src, target: parts.target ?? parts.dst ?? parts.destination };
}
function safeConfiguration(config) {
  if (config.appPort?.length || typeof config.appPort === 'number') throw new Error('Use forwardPorts instead of appPort. The provider owns host port publication.');
  const args = config.runArgs ?? [];
  if (!Array.isArray(args) || args.some(arg => /^(-p|-P|-v|-l|--publish|--publish-all|--network|--net|--name|--label|--mount|--volume|--volumes-from|--link|--env-file|--rm)(=|$)/.test(arg) || /^-[pPvl].+/.test(arg))) {
    throw new Error('Remove runArgs that control names, labels, networks, mounts, or published ports. Use native configuration fields.');
  }
}

export class DevcontainerProvider {
  async resources(handle, kind = 'container') {
    const ids = (await docker(handle.spec, [kind, 'ls', ...(kind === 'container' ? ['-aq'] : ['-q']), '--filter', `label=${labelKey}=${handle.record}`])).split(/\s+/).filter(Boolean);
    if (!ids.length) return [];
    const found = JSON.parse(await docker(handle.spec, [kind, 'inspect', ...new Set(ids)]));
    if (found.some(info => !owns(handle, info))) throw new Error('A Dev Container resource has conflicting ownership labels.');
    return found;
  }
  async check(handle) {
    localOnly(handle.spec);
    const directory = join(home, 'devcontainer', digest(`${handle.spec.owner}:${handle.spec.name}`));
    if (handle.runtimeDirectory !== directory || handle.runtimeFile !== join(directory, 'devcontainer.json') || handle.project !== `agent-env-dc-${handle.record}`) throw new Error('The Dev Container handle has an invalid runtime path.');
    const record = JSON.parse(await readFile(join(directory, 'ownership.json'), 'utf8'));
    if (record.record !== handle.record || record.owner !== handle.spec.owner || record.name !== handle.spec.name) throw new Error('The Dev Container ownership record does not match this handle.');
  }
  async volume(handle, source, extraLabels = {}) {
    const name = `${handle.project}-v-${digest(source)}`;
    const existing = (await docker(handle.spec, ['volume', 'ls', '-q', '--filter', `name=^${name}$`])).trim();
    if (existing) {
      const [info] = JSON.parse(await docker(handle.spec, ['volume', 'inspect', name]));
      if (!owns(handle, info)) throw new Error('An existing volume belongs to another instance.');
    } else await docker(handle.spec, ['volume', 'create', ...Object.entries({ ...extraLabels, ...labels(handle) }).flatMap(([key, value]) => ['--label', `${key}=${value}`]), name]);
    return name;
  }
  async prepare(handle) {
    const config = structuredClone(handle.spec.devcontainer.configuration);
    safeConfiguration(config);
    if (config.build || config.dockerFile) {
      config.build = { ...(config.build ?? { dockerfile: config.dockerFile, context: config.context ?? '.' }) };
      if ((config.build.options ?? []).some(option => /^(?:-t|--tag|--push|--output)(?:=|$)/.test(option) || /^-t.+/.test(option))) throw new Error('Remove build options that publish images or select additional output tags.');
      // The pinned CLI uses image as the Dockerfile output tag. Keep that tag unique per ownership record.
      config.image = `${handle.project}-workspace:agent-env`;
      config.build.options = [...(config.build.options ?? []), ...Object.entries(labels(handle)).flatMap(([key, value]) => ['--label', `${key}=${value}`])];
    }
    // Resolve local substitutions through the official CLI. Preserve remote substitutions in the runtime copy.
    const normalized = JSON.parse(await cli(handle.spec, 'read-configuration')).configuration;
    for (let index = 0; index < (config.mounts ?? []).length; index++) {
      const mount = mountObject(normalized.mounts[index]);
      if (mount.type === 'volume') {
        if (!mount.source) throw new Error('Dev Container volume mounts require a source name.');
        mount.source = await this.volume(handle, mount.source);
        config.mounts[index] = mount;
      }
    }
    if (config.workspaceMount && mountObject(normalized.workspaceMount).type !== 'bind') throw new Error('Use a local bind mount for the Dev Container workspace.');
    if (config.dockerComposeFile) {
      const model = await composeModel(handle.spec, normalized, handle.project);
      model.name = handle.project;
      const services = model.services ?? {};
      const networkOwner = name => {
        const visited = new Set();
        while (services[name]?.network_mode) {
          if (visited.has(name)) throw new Error('Compose services cannot share network namespaces in a cycle.');
          visited.add(name);
          const target = /^service:([a-zA-Z0-9_.-]+)$/.exec(services[name].network_mode)?.[1];
          if (!target || !services[target]) throw new Error('Use default Compose networking or network_mode: service:NAME within this project.');
          name = target;
        }
        return name;
      };
      const published = new Map(Object.keys(services).map(name => [name, new Set()]));
      for (const [name, service] of Object.entries(services)) {
        const ports = published.get(networkOwner(name));
        if (service.ports?.some(port => (port.protocol ?? 'tcp') !== 'tcp' || !portNumber(port.target))) throw new Error('Dev Container Compose ports must use individual TCP ports.');
        for (const port of service.ports ?? []) ports.add(Number(port.target));
      }
      for (const route of Object.values(handle.services)) {
        if (!services[route.devcontainerService]) throw new Error('A Dev Container route references an unknown Compose service.');
        route.networkService = networkOwner(route.devcontainerService);
        if (!route.internal) published.get(route.networkService).add(route.containerPort);
      }
      for (const service of Object.values(services)) handle.spec.sensitiveValues = [...new Set([...(handle.spec.sensitiveValues ?? []), ...credentialValues(service.environment)])];
      const builtImages = new Map(Object.entries(services).filter(([, service]) => service.build && service.image).map(([name, service]) => [service.image, `${handle.project}-${name}:agent-env`]));
      if (!services[config.service]) throw new Error('The Dev Container workspace service does not exist in Compose.');
      for (const [name, service] of Object.entries(services)) {
        if (service.volumes_from?.length || service.external_links?.length || service.provider || service.scale > 1 || service.deploy?.replicas > 1) throw new Error('This Compose configuration cannot isolate containers between instances.');
        delete service.container_name;
        service.labels = { ...service.labels, ...labels(handle) };
        const originalImage = service.image;
        if (builtImages.has(originalImage)) service.image = builtImages.get(originalImage);
        if (service.build) {
          service.image ??= `${handle.project}-${name}:agent-env`;
          service.build.labels = { ...service.build.labels, ...labels(handle) };
          if (service.build.tags?.length) throw new Error('Remove additional Compose build tags to prevent image collisions.');
        }
        delete service.ports;
        if (!service.network_mode) service.ports = [...published.get(name)].map(target => ({ target, published: '0', host_ip: '127.0.0.1', protocol: 'tcp' }));
        for (const mount of service.volumes ?? []) {
          if (mount.type === 'volume' && !mount.source) throw new Error('Use named Compose volumes to retain data across removal.');
        }
        for (const network of Object.values(service.networks ?? {})) if (network?.ipv4_address || network?.ipv6_address || network?.mac_address) throw new Error('Static Compose network addresses cannot be isolated.');
      }
      for (const [name, resource] of Object.entries(model.volumes ?? {})) {
        if (resource.external || resource.driver_opts && Object.keys(resource.driver_opts).length || resource.driver && resource.driver !== 'local') throw new Error('Use ordinary managed Compose volumes for instance isolation.');
        resource.name = await this.volume(handle, `compose:${name}`, { 'com.docker.compose.project': handle.project, 'com.docker.compose.volume': name });
        resource.labels = { ...resource.labels, ...labels(handle) };
      }
      for (const [name, resource] of Object.entries(model.networks ?? {})) {
        if (resource.external || resource.ipam && Object.keys(resource.ipam).length || resource.driver_opts && Object.keys(resource.driver_opts).length || resource.driver && resource.driver !== 'bridge') throw new Error('Use ordinary managed Compose networks for instance isolation.');
        resource.name = `${handle.project}-n-${digest(name)}`;
        const present = await docker(handle.spec, ['network', 'ls', '-q', '--filter', `name=^${resource.name}$`]);
        if (present) {
          const [network] = JSON.parse(await docker(handle.spec, ['network', 'inspect', present]));
          if (!owns(handle, network)) throw new Error('An existing network belongs to another instance.');
        }
        resource.labels = { ...resource.labels, ...labels(handle) };
      }
      if (['configs', 'secrets'].some(kind => Object.values(model[kind] ?? {}).some(resource => resource.external))) throw new Error('External Compose configs and secrets are not supported.');
      const runtimeCompose = join(handle.runtimeDirectory, 'compose.json');
      await writeFile(runtimeCompose, JSON.stringify(model), { mode: 0o600 });
      config.dockerComposeFile = [runtimeCompose];
      handle.compose = true;
    } else {
      const ports = Object.values(handle.services).filter(service => !service.internal);
      if (ports.some(service => service.devcontainerService !== handle.primaryService)) throw new Error('Image and Dockerfile routes must target the workspace service.');
      config.runArgs = [...(config.runArgs ?? []), ...Object.entries(labels(handle)).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
        ...ports.flatMap(service => ['--publish', `127.0.0.1::${service.containerPort}`])];
    }
    await writeFile(handle.runtimeFile, JSON.stringify(config), { mode: 0o600 });
  }
  async create(input) {
    const spec = input.devcontainer?.configuration ? input : await resolveDevcontainerSpec(input);
    localOnly(spec);
    if (!/^[a-z0-9-]+$/.test(spec.owner ?? '') || !/^[a-z][a-z0-9-]{0,47}$/.test(spec.name ?? '')) throw new Error('Dev Containers require a valid owner and instance name.');
    const endpoint = JSON.parse(await docker(spec, ['context', 'inspect']))[0]?.Endpoints?.docker?.Host;
    if (!endpoint?.startsWith('unix://')) throw new Error('Dev Containers require a local Docker context.');
    const directory = join(home, 'devcontainer', digest(`${spec.owner}:${spec.name}`));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const recordFile = join(directory, 'ownership.json');
    let record;
    try { record = JSON.parse(await readFile(recordFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      record = { record: randomUUID(), owner: spec.owner, name: spec.name };
      await writeFile(recordFile, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    }
    if (record.owner !== spec.owner || record.name !== spec.name || !/^[0-9a-f-]{36}$/.test(record.record)) throw new Error('The existing Dev Container ownership record is invalid.');
    const handle = { spec, record: record.record, project: `agent-env-dc-${record.record}`, runtimeDirectory: directory,
      runtimeFile: join(directory, 'devcontainer.json'), workspace: spec.cwd, primaryService: spec.primaryService ?? spec.devcontainer.configuration.service ?? 'workspace',
      services: structuredClone(spec.services) };
    if ((await this.resources(handle)).length) throw new Error('This Dev Container instance already has containers. Resume its existing handle.');
    const previousVolumes = new Set((await this.resources(handle, 'volume')).map(info => info.Name));
    try {
      await this.prepare(handle);
      await this.launch(handle, false);
      return handle;
    } catch (error) {
      try {
        await this.removeCompute(handle);
        for (const info of await this.resources(handle, 'volume')) if (!previousVolumes.has(info.Name)) await docker(spec, ['volume', 'rm', info.Name]);
        await this.removeImages(handle);
        if (!previousVolumes.size) await rm(directory, { recursive: true, force: true });
      } catch { error.message += ' Resource cleanup failed. Retain the private ownership record and retry cleanup.'; }
      throw error;
    }
  }
  async launch(handle, existing) {
    await this.check(handle);
    if (handle.compose) {
      const ids = (await docker(handle.spec, ['ps', '-aq', '--filter', `label=com.docker.compose.project=${handle.project}`])).split(/\s+/).filter(Boolean);
      if (ids.length && JSON.parse(await docker(handle.spec, ['inspect', ...ids])).some(info => !owns(handle, info))) throw new Error('The Compose project contains a container with different ownership.');
    }
    if (existing) await this.refresh(handle);
    const result = JSON.parse(await cli(handle.spec, 'up', ['--no-lockfile', '--mount-workspace-git-root', 'false', ...(existing ? ['--expect-existing-container'] : [])], handle));
    if (result.outcome !== 'success') throw new Error('The Dev Container did not start.');
    handle.container = result.containerId;
    handle.remoteWorkspace = result.remoteWorkspaceFolder;
    await this.wait(handle);
  }
  async refresh(handle) {
    await this.check(handle);
    const containers = await this.resources(handle);
    const primary = handle.compose ? containers.filter(info => info.Config.Labels['com.docker.compose.service'] === handle.primaryService) : containers;
    if (primary.length !== 1 || handle.container && primary[0].Id !== handle.container) throw new Error('The owned workspace container is missing or ambiguous.');
    handle.container = primary[0].Id;
    for (const service of Object.values(handle.services)) {
      const matches = handle.compose ? containers.filter(info => info.Config.Labels['com.docker.compose.service'] === service.devcontainerService) : primary;
      if (matches.length !== 1) throw new Error('A Dev Container service is missing or has multiple containers.');
      const info = matches[0];
      service.container = info.Id;
      service.state = info.State.Status;
      if (service.internal) continue;
      const network = service.networkService ? containers.find(info => info.Config.Labels['com.docker.compose.service'] === service.networkService) : info;
      if (!network?.State.Running && info.State.Running) throw new Error('The Dev Container network service is not running.');
      const ports = network?.NetworkSettings.Ports[`${service.containerPort}/tcp`] ?? [];
      if (info.State.Running && (ports.length !== 1 || ports[0].HostIp !== '127.0.0.1' || !Number(ports[0].HostPort))) throw new Error('A Dev Container route lacks an isolated loopback port.');
      service.hostPort = Number(ports[0]?.HostPort);
    }
  }
  async wait(handle) {
    const deadline = Date.now() + (handle.spec.startupTimeoutSeconds ?? 60) * 1000;
    for (;;) {
      await this.refresh(handle);
      if (Object.values(handle.services).some(service => service.state !== 'running')) throw new Error('A Dev Container service is not running.');
      let ready = true;
      for (const service of Object.values(handle.services).filter(service => !service.internal && service.waitForPort !== false)) {
        if (!await reachable(service.hostPort)) { ready = false; continue; }
        if (service.protocol === 'http') ready = await new Promise(resolveResult => {
          const req = http.get({ host: '127.0.0.1', port: service.hostPort, path: '/' }, response => { response.resume(); resolveResult(true); });
          req.setTimeout(1000, () => req.destroy());
          req.on('error', () => resolveResult(false));
        }) && ready;
      }
      if (ready) return;
      if (Date.now() >= deadline) throw new Error('A Dev Container route did not become ready. Bind the service to 0.0.0.0.');
      await delay(250);
    }
  }
  async connect(handle) {
    await this.wait(handle);
    return Object.entries(handle.services).filter(([, service]) => !service.internal).map(([name, service]) => ({ name, backendPort: service.hostPort, close() {} }));
  }
  async start(handle) {
    const normalized = JSON.parse(await cli(handle.spec, 'read-configuration')).configuration;
    if (handle.spec.devcontainer.composeHash !== await composeHash(handle.spec, normalized)) {
      throw new Error(`Dev Container Compose configuration changed. Run agent-env rm ${handle.spec.name}, then up from the checkout. Data remains.`);
    }
    return this.launch(handle, true);
  }
  async stop(handle) {
    await this.check(handle);
    const containers = await this.resources(handle);
    if (containers.length) await docker(handle.spec, ['stop', '-t', '5', ...containers.map(info => info.Id)]);
  }
  async removeCompute(handle) {
    await this.check(handle);
    const containers = await this.resources(handle);
    if (containers.length) await docker(handle.spec, ['rm', '-f', '-v', ...containers.map(info => info.Id)]);
    for (const network of await this.resources(handle, 'network')) await docker(handle.spec, ['network', 'rm', network.Id]);
  }
  async removeImages(handle) {
    const images = await this.resources(handle, 'image');
    for (const image of images) {
      // The official CLI names Dockerfile images from the workspace path. Labels prove ownership before removal.
      const tags = (image.RepoTags ?? []).filter(tag => tag.startsWith(`${handle.project}-`) || tag.startsWith('vsc-'));
      for (const tag of tags) await docker(handle.spec, ['image', 'rm', tag]);
      if (!image.RepoTags?.length) await docker(handle.spec, ['image', 'rm', image.Id]);
    }
  }
  async remove(handle, purge = false) {
    await this.removeCompute(handle);
    if (purge) {
      for (const volume of await this.resources(handle, 'volume')) await docker(handle.spec, ['volume', 'rm', volume.Name]);
      await this.removeImages(handle);
      await rm(handle.runtimeDirectory, { recursive: true, force: true });
    }
  }
  async status(handle) {
    await this.check(handle);
    const containers = await this.resources(handle);
    return Object.fromEntries(Object.entries(handle.services).map(([name, service]) => {
      const info = containers.find(info => handle.compose ? info.Config.Labels['com.docker.compose.service'] === service.devcontainerService : info.Id === handle.container);
      return [name, info?.State.Status ?? 'missing'];
    }));
  }
  async sync(handle) { await this.check(handle); }
  async logs(handle, service = handle.primaryService) {
    await this.refresh(handle);
    if (!handle.services[service]) throw new Error('The Dev Container service does not exist.');
    return redactEnvironment(await docker(handle.spec, ['logs', '--tail', '100', handle.services[service].container]), sensitiveValuesForSpec(handle.spec));
  }
  async exec(handle, service, argv) {
    await this.refresh(handle);
    if (handle.services[service]?.devcontainerService !== handle.primaryService) throw new Error('Dev Container exec requires the primary workspace service.');
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string')) throw new Error('Specify command arguments for Dev Container exec.');
    return redactEnvironment(await cli(handle.spec, 'exec', ['--container-id', handle.container, '--', ...argv], handle), sensitiveValuesForSpec(handle.spec));
  }
}
