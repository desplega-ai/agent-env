import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DockerProvider } from './docker.mjs';
import { hash, validate } from '../config.mjs';
import { parseEnvFile, redactEnvironment, sensitiveValuesForSpec } from '../environments.mjs';
import { home } from '../paths.mjs';
import { quote, run } from '../system.mjs';
import { shouldSync } from '../source-paths.mjs';

export async function detectComposeFiles(cwd) {
  for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
    try {
      if ((await stat(join(cwd, name))).isFile()) {
        const override = name.startsWith('docker-') ? 'docker-compose.override' : 'compose.override';
        for (const extension of ['.yaml', '.yml']) {
          try { if ((await stat(join(cwd, `${override}${extension}`))).isFile()) return [name, `${override}${extension}`]; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return [name];
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [];
}

function sourceArgs(spec) {
  return ['compose', '--project-directory', spec.cwd, '--project-name', 'agent-env-parse',
    ...spec.compose.files.flatMap(file => ['-f', file]),
    ...(spec.compose.profiles ?? []).flatMap(profile => ['--profile', profile]),
    ...(spec.envFiles?.length ? spec.envFiles : ['/dev/null']).flatMap(file => ['--env-file', file])];
}
function composeEnvironment(spec) {
  // The caller selects files and profiles. Ambient Compose options must not change that selection.
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_'))), ...spec.env };
}
async function parseCompose(spec, options = []) {
  if (!spec.compose.files.length) throw new Error('No Compose file exists. Specify --compose-file FILE.');
  try {
    return JSON.parse(await run('docker', [...sourceArgs(spec), '--profile', '*', 'config', '--format', 'json', ...options], { env: composeEnvironment(spec) }));
  } catch {
    // Compose diagnostics can contain expanded secrets. Never copy them into daemon logs.
    throw new Error('Cannot normalize Compose configuration. Check Docker Compose, source files, profiles, and required environment variables.');
  }
}
async function interpolationEnvironment(spec) {
  try {
    const output = await run('docker', [...sourceArgs(spec), 'config', '--environment'], { env: composeEnvironment(spec) });
    return Object.fromEntries(output.split(/\n(?=[A-Za-z_][A-Za-z0-9_]*=)/).map(line => {
      const position = line.indexOf('=');
      return [line.slice(0, position), line.slice(position + 1)];
    }).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)));
  } catch { throw new Error('Cannot resolve the Compose environment. Check source files and required variable references.'); }
}
async function interpolationKeys(spec) {
  try {
    const output = await run('docker', [...sourceArgs(spec), 'config', '--variables'], { env: composeEnvironment(spec) });
    if (output && !/^NAME\s/.test(output)) throw new Error();
    return output.split('\n').slice(1).map(line => /^([A-Za-z_][A-Za-z0-9_]*)\s/.exec(line)?.[1]).filter(Boolean);
  } catch { throw new Error('Cannot identify Compose variables. Use Docker Compose with config --variables support.'); }
}
function activeServices(model, profiles = []) {
  return Object.entries(model.services ?? {}).filter(([, service]) => !service.profiles?.length || profiles.includes('*') || service.profiles.some(profile => profiles.includes(profile)));
}
function checkUnsupported(model) {
  if (model.models && Object.keys(model.models).length) throw new Error('Compose models are not supported by this provider.');
  if (['configs', 'secrets'].some(kind => Object.values(model[kind] ?? {}).some(resource => resource.external || resource.driver))) throw new Error('External Compose configs and secrets require a Swarm provider. Use private file sources.');
  for (const service of Object.values(model.services ?? {})) {
    if (service.network_mode && service.network_mode !== 'none') throw new Error('Compose network_mode bypasses isolated networks. Use Compose networks.');
    if (service.provider) throw new Error('External Compose service providers require a separate provider adapter.');
    if (service.pid === 'host' || service.ipc === 'host' || service.uts === 'host' || service.use_api_socket) throw new Error('Host namespaces and Docker API sockets are not supported by this provider.');
    if ((service.scale ?? 1) !== 1 || (service.deploy?.replicas ?? 1) !== 1) throw new Error('Compose replicas require routing support. Use one replica per service.');
    if (Object.keys(service.deploy ?? {}).some(key => !['replicas', 'resources', 'restart_policy'].includes(key))) throw new Error('This Compose deployment feature requires a Swarm provider.');
    if (service.build?.tags?.length) throw new Error('Additional build tags can collide across instances. Use the isolated build image.');
    if (service.ports?.some(port => (port.protocol ?? 'tcp') !== 'tcp')) throw new Error('UDP and SCTP routes are not supported. Use TCP ports.');
    if (service.volumes?.some(volume => volume.type === 'bind' && /(^|\/)docker\.sock$/.test(volume.source))) throw new Error('Docker socket mounts bypass instance isolation and are not supported.');
    if (service.networks && Object.values(service.networks).some(network => network?.ipv4_address || network?.ipv6_address || network?.mac_address)) throw new Error('Static network addresses cannot be isolated automatically.');
    if (service.mac_address) throw new Error('Static MAC addresses cannot be isolated automatically.');
    if (service.volumes_from?.length || service.external_links?.length) throw new Error('External container links and volumes_from are not supported. Use Compose dependencies and volumes.');
    if (service.develop) throw new Error('Compose develop configuration requires a watch provider. Use agent-env sync.');
    if (service.ports?.some(port => port.mode && port.mode !== 'ingress')) throw new Error('Compose host port mode is not supported. Use the default port mode.');
  }
  for (const [kind, resources] of Object.entries({ networks: model.networks, volumes: model.volumes })) {
    for (const resource of Object.values(resources ?? {})) {
      if (!resource.external && kind === 'networks' && (Object.keys(resource.ipam ?? {}).length || Object.keys(resource.driver_opts ?? {}).length || resource.driver && resource.driver !== 'bridge')) throw new Error('Custom network drivers, options, and IPAM require explicit isolation support.');
      if (!resource.external && kind === 'volumes' && resource.driver_opts && Object.keys(resource.driver_opts).length) throw new Error('Volume driver options can share host storage. Use ordinary named volumes or external volumes.');
    }
  }
}

export function composeServiceMetadata(model, compose = {}) {
  const active = activeServices(model, compose.profiles);
  checkUnsupported({ ...model, services: Object.fromEntries(active) });
  const services = {};
  const routes = compose.routes ?? {};
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error('Compose routes must map aliases to route definitions.');
  const consumed = new Set();
  for (const [name, service] of active) {
    const ports = service.ports ?? [];
    if (!ports.length) {
      if (Object.hasOwn(services, name)) throw new Error('A route alias collides with a Compose service name.');
      services[name] = { composeService: name, internal: true };
      continue;
    }
    for (const published of ports) {
      const target = Number(published.target);
      if (!Number.isInteger(target) || target < 1 || target > 65535) throw new Error('Compose port ranges require separate route definitions and are not supported.');
      const entries = Object.entries(routes).filter(([, route]) => route?.service === name && Number(route.target) === target);
      if (entries.length > 1) throw new Error('Define one route alias for each published Compose port.');
      if (!entries.length && ports.length > 1) throw new Error(`Service ${name} publishes multiple ports. Define compose.routes aliases with service, target, port, and protocol.`);
      const [alias, route] = entries[0] ?? [name, {}];
      if (Object.hasOwn(services, alias) || consumed.has(alias)) throw new Error('A route alias collides with another service or route.');
      consumed.add(alias);
      const port = Number(route.port ?? published.published);
      if (!port) throw new Error(`Define a public port in compose.routes for ${name}:${target}.`);
      const appProtocol = published.app_protocol;
      const protocol = route.protocol ?? (appProtocol === 'http' || [80, 3000, 4173, 4200, 4321, 5000, 5173, 8000, 8080, 8081, 8888, 9000].includes(target) ? 'http' : 'tcp');
      if (appProtocol && !['http', 'tcp'].includes(appProtocol) && !route.protocol) throw new Error(`Set an explicit route protocol for ${name}:${target}.`);
      services[alias] = { composeService: name, containerPort: target, port, protocol, transport: 'tcp' };
    }
  }
  const activeNames = new Set(active.map(([name]) => name));
  for (const [alias, route] of Object.entries(routes)) {
    if (consumed.has(alias)) continue;
    const service = model.services?.[route?.service];
    if (!activeNames.has(route?.service) && service?.ports?.some(port => Number(port.target) === Number(route.target))) continue;
    throw new Error(`Route ${alias} does not match a published Compose port.`);
  }
  return services;
}
export async function resolveComposeSpec(spec) {
  const model = await parseCompose(spec);
  const environment = await interpolationEnvironment(spec);
  const keys = new Set([...Object.keys(spec.env ?? {}), ...await interpolationKeys(spec)]);
  const sensitiveValues = [...(spec.sensitiveValues ?? [])];
  for (const file of spec.envFiles ?? []) {
    try {
      const values = parseEnvFile(await readFile(file, 'utf8'));
      for (const key of Object.keys(values)) { keys.add(key); sensitiveValues.push(values[key], environment[key]); }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const kind of ['configs', 'secrets']) {
    for (const resource of Object.values(model[kind] ?? {})) if (resource.environment) keys.add(resource.environment);
  }
  const captured = Object.fromEntries([...keys].filter(key => Object.hasOwn(environment, key)).map(key => [key, environment[key]]));
  for (const key of keys) if (!Object.hasOwn(spec.env ?? {}, key) && Object.hasOwn(process.env, key)) sensitiveValues.push(captured[key]);
  const unresolved = await parseCompose(spec, ['--no-env-resolution']);
  for (const [name, service] of Object.entries(unresolved.services ?? {})) {
    for (const file of service.env_file ?? []) {
      try {
        const source = await readFile(resolve(spec.cwd, (typeof file === 'string' ? file : file.path).replaceAll('$$', '$')), 'utf8');
        for (const line of source.split('\n')) {
          const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|$)/.exec(line)?.[1];
          if (!key || Object.hasOwn(service.environment ?? {}, key)) continue;
          const value = model.services[name]?.environment?.[key];
          if (typeof value === 'string') sensitiveValues.push(value.replaceAll('$$', '$'));
        }
      }
      catch (error) { if (error.code !== 'ENOENT' || file.required !== false) throw new Error('Cannot read a Compose environment file. Check its path and permissions.'); }
    }
  }
  for (const resource of Object.values(model.secrets ?? {})) {
    if (resource.environment) sensitiveValues.push(captured[resource.environment]);
    if (resource.file) sensitiveValues.push(await readFile(resolve(spec.cwd, resource.file.replaceAll('$$', '$')), 'utf8'));
  }
  // Capture the resolved model before the CLI sends it to a daemon with another shell environment.
  return { ...spec, sensitiveValues: [...new Set(sensitiveValues.filter(value => typeof value === 'string' && value))].sort(), compose: { ...spec.compose, model, environment: captured }, services: composeServiceMetadata(model, spec.compose) };
}

async function checkoutPath(spec, source, workspace, transferredSeparately = false) {
  const absolute = resolve(spec.cwd, source.replaceAll('$$', '$'));
  const actual = await realpath(absolute).catch(error => {
    if (error.code === 'ENOENT') throw new Error('A remote Compose path does not exist in the checkout.');
    throw error;
  });
  const path = relative(spec.cwd, actual);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Remote Compose bind, build, config, and secret paths must remain inside the checkout.');
  if (!transferredSeparately && !shouldSync(path)) throw new Error('Remote Compose paths cannot use files excluded from checkout synchronization.');
  return { actual, remote: join(workspace, path).replaceAll('$', '$$'), relative: path };
}
function remoteContext(source) {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|git@|service:|docker-image:)/i.test(source);
}
// The normalized model stays private. The source files remain unchanged.
export class ComposeProvider extends DockerProvider {
  snapshotVolumeNames(spec, manifest) {
    return Object.fromEntries(manifest.volumes.map(volume => {
      const names = volume.mounts.map(mount => {
        const service = spec.compose.model.services[spec.services[mount.service]?.composeService];
        const source = service?.volumes?.find(item => item.type === 'volume' && item.target === mount.target)?.source;
        const definition = spec.compose.model.volumes?.[source];
        if (!source || !definition || definition.external) throw new Error(`Snapshot mount ${mount.service}:${mount.target} requires a managed destination volume.`);
        return `${this.prefix(spec)}-${source}`;
      });
      if (new Set(names).size !== 1) throw new Error('Preserve shared volume mounts when restoring a Compose snapshot.');
      return [volume.id, names[0]];
    }));
  }
  snapshotVolumeLabels(spec, name) {
    const source = Object.keys(spec.compose.model.volumes ?? {}).find(key => `${this.prefix(spec)}-${key}` === name);
    if (!source) throw new Error('The destination volume does not match this Compose project.');
    return { 'com.docker.compose.project': this.prefix(spec), 'com.docker.compose.volume': source };
  }
  relocate(spec, cwd) {
    const result = structuredClone(spec);
    const remap = path => typeof path === 'string' && (path === spec.cwd || path.startsWith(`${spec.cwd}${sep}`)) ? cwd + path.slice(spec.cwd.length) : path;
    result.cwd = cwd;
    result.envFiles = result.envFiles?.map(remap);
    result.compose.files = result.compose.files.map(remap);
    for (const service of Object.values(result.compose.model.services)) {
      for (const volume of service.volumes ?? []) if (volume.type === 'bind') volume.source = remap(volume.source);
      if (service.build) {
        service.build.context = remap(service.build.context);
        service.build.dockerfile = remap(service.build.dockerfile);
        for (const [key, path] of Object.entries(service.build.additional_contexts ?? {})) service.build.additional_contexts[key] = remap(path);
      }
    }
    for (const kind of ['configs', 'secrets']) for (const resource of Object.values(result.compose.model[kind] ?? {})) resource.file = remap(resource.file);
    return result;
  }
  async docker(spec, args, options) {
    try { return await super.docker(spec, args, options); }
    catch (error) { throw Object.assign(new Error(redactEnvironment(error.message, sensitiveValuesForSpec(spec))), { exitCode: error.exitCode ?? 1 }); }
  }
  async compose(handle, args) {
    try {
      return await this.docker(handle.spec, ['compose', '--project-name', handle.project, '--project-directory', handle.workspace,
        '--env-file', '/dev/null', '-f', handle.runtimeFile,
        ...(handle.spec.compose.profiles ?? []).flatMap(profile => ['--profile', profile]), ...args], { env: { ...composeEnvironment({}), COMPOSE_DISABLE_ENV_FILE: '1' } });
    } catch (error) {
      throw Object.assign(new Error(`Compose ${args[0]} failed. Check service status and redacted logs.`), { exitCode: error.exitCode ?? 1 });
    }
  }
  async prepare(spec, workspace, directory) {
    const model = structuredClone(spec.compose.model ?? await parseCompose(spec));
    const environment = spec.compose.environment ?? await interpolationEnvironment(spec);
    const redactions = sensitiveValuesForSpec(spec);
    const services = composeServiceMetadata(model, spec.compose);
    if (JSON.stringify(services) !== JSON.stringify(spec.services)) throw new Error('Compose routes changed after configuration. Load the specification again.');
    const project = this.prefix(spec);
    delete model.name;
    model.services = Object.fromEntries(activeServices(model, spec.compose.profiles));
    const used = { volumes: new Set(), networks: new Set(), configs: new Set(), secrets: new Set() };
    for (const service of Object.values(model.services)) {
      for (const volume of service.volumes ?? []) if (volume.type === 'volume' && volume.source) used.volumes.add(volume.source);
      for (const network of Object.keys(service.networks ?? {})) used.networks.add(network);
      for (const kind of ['configs', 'secrets']) for (const item of service[kind] ?? []) used[kind].add(typeof item === 'string' ? item : item.source);
      for (const item of service.build?.secrets ?? []) used.secrets.add(typeof item === 'string' ? item : item.source);
    }
    for (const [kind, names] of Object.entries(used)) {
      if (model[kind]) model[kind] = Object.fromEntries(Object.entries(model[kind]).filter(([name]) => names.has(name)));
    }
    const builtImages = new Map();
    for (const [name, service] of Object.entries(model.services)) {
      if (service.build && service.image) builtImages.set(service.image, `${project}-image-${hash(service.image)}:agent-env`);
    }
    for (const [name, service] of Object.entries(model.services)) {
      const originalName = service.container_name;
      for (const [network, settings] of Object.entries(service.networks ?? {})) {
        if (!originalName || model.networks?.[network]?.external) continue;
        service.networks[network] = { ...settings, aliases: [...new Set([...(settings?.aliases ?? []), originalName])] };
      }
      delete service.container_name;
      if (builtImages.has(service.image)) {
        service.image = builtImages.get(service.image);
        service.pull_policy = service.build ? 'build' : 'never';
      } else if (service.build) {
        service.image = `${project}-${name}:agent-env`;
        service.pull_policy = 'build';
      }
      service.ports = (service.ports ?? []).map(port => ({ target: port.target, protocol: 'tcp', host_ip: '127.0.0.1', published: '0' }));
      if (spec.host) {
        for (const volume of service.volumes ?? []) {
          if (volume.type !== 'bind') continue;
          const mapped = await checkoutPath(spec, volume.source, workspace);
          volume.source = mapped.remote;
        }
        if (service.build) {
          const build = service.build;
          const originalContext = build.context;
          if (originalContext && !remoteContext(originalContext)) build.context = (await checkoutPath(spec, originalContext, workspace)).remote;
          if (build.dockerfile && isAbsolute(build.dockerfile)) build.dockerfile = (await checkoutPath(spec, build.dockerfile, workspace)).remote;
          else if (build.dockerfile && originalContext && !remoteContext(originalContext)) await checkoutPath(spec, resolve(originalContext, build.dockerfile), workspace);
          for (const [key, context] of Object.entries(build.additional_contexts ?? {})) {
            if (!remoteContext(context)) build.additional_contexts[key] = (await checkoutPath(spec, context, workspace)).remote;
          }
          if (build.ssh?.length) throw new Error('Remote Compose builds cannot forward local SSH agents.');
          if ([...(build.cache_from ?? []), ...(build.cache_to ?? [])].some(cache => /(?:^|,)type=local(?:,|$)/.test(cache))) throw new Error('Remote Compose builds cannot use local cache paths.');
        }
        if (service.credential_spec?.file || service.label_file) throw new Error('Remote Compose credential and label files require explicit transfer support.');
        if (service.devices?.length) throw new Error('Remote Compose devices require explicit host configuration.');
      }
    }
    for (const kind of ['volumes', 'networks']) {
      for (const [name, resource] of Object.entries(model[kind] ?? {})) {
        if (!resource.external) {
          resource.name = `${project}-${name}`;
          resource.labels = { ...resource.labels, 'agent-env.owner': spec.owner };
        }
      }
    }
    const assets = [];
    for (const kind of ['configs', 'secrets']) {
      for (const [name, resource] of Object.entries(model[kind] ?? {})) {
        if (resource.external) continue;
        if (resource.environment) {
          const value = environment[resource.environment];
          if (value === undefined) throw new Error('A Compose secret references an undefined environment variable.');
          const filename = join(directory, `${kind}-${hash(name)}`);
          await writeFile(filename, value, { mode: 0o600 });
          delete resource.environment;
          resource.file = filename;
        }
        if (!resource.file || !spec.host) continue;
        const local = resource.file.startsWith(`${directory}${sep}`) ? resource.file : (await checkoutPath(spec, resource.file, workspace, true)).actual;
        const filename = `${kind}-${hash(name)}`;
        assets.push({ local, remote: join(workspace, '.agent-env', filename) });
        resource.file = join(workspace, '.agent-env', filename);
      }
    }
    const localFile = join(directory, 'compose.json');
    await writeFile(join(directory, 'redactions.json'), JSON.stringify(redactions), { mode: 0o600 });
    // Compose config already escapes interpolation for another Compose invocation.
    await writeFile(localFile, `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
    return { project, services, localFile, assets, ownedVolumes: Object.values(model.volumes ?? {}).filter(volume => !volume.external).map(volume => volume.name) };
  }
  async create(spec) {
    validate(spec);
    if (!/^[a-z0-9-]+$/.test(spec.owner ?? '')) throw new Error('Compose instances require a valid owner identifier.');
    await this.docker(spec, ['info', '--format', '{{.ServerVersion}}']);
    const existing = await this.docker(spec, ['ps', '-aq', '--filter', `label=com.docker.compose.project=${this.prefix(spec)}`]);
    if (existing) throw new Error('This Compose project already has containers. Reconnect its existing handle or choose another instance name.');
    const previousVolumes = new Set((await this.docker(spec, ['volume', 'ls', '-q'])).split(/\s+/));
    await mkdir(home, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(home, 'compose-'));
    await chmod(directory, 0o700);
    let handle;
    let attempted = false;
    try {
      const workspace = spec.host ? `${await this.command(spec, ['pwd'])}/.local/share/agent-env/${spec.owner}/${spec.name}` : spec.cwd;
      const prepared = await this.prepare(spec, workspace, directory);
      handle = { spec, workspace, project: prepared.project, services: prepared.services, ownedVolumes: prepared.ownedVolumes, runtimeDirectory: directory,
        runtimeFile: spec.host ? join(workspace, '.agent-env', 'compose.json') : prepared.localFile };
      if (spec.host) {
        await this.command(spec, ['mkdir', '-p', workspace]);
        await this.command(spec, ['chmod', '700', workspace]);
      }
      await this.sync(handle);
      if (spec.host) {
        const remoteDirectory = join(workspace, '.agent-env');
        await this.command(spec, ['mkdir', '-p', remoteDirectory]);
        await this.command(spec, ['chmod', '700', remoteDirectory]);
        for (const asset of [...prepared.assets, { local: prepared.localFile, remote: handle.runtimeFile }]) {
          await run('rsync', ['-az', '-e', ['ssh', ...this.sshArgs(spec)].map(quote).join(' '), asset.local, `${spec.host}:${quote(asset.remote)}`]);
          await this.command(spec, ['chmod', '600', asset.remote]);
        }
      }
      attempted = true;
      await this.compose(handle, ['up', '-d', '--build', '--wait', '--wait-timeout', String(spec.startupTimeoutSeconds ?? 60)]);
      await this.wait(handle);
      return handle;
    } catch (error) {
      if (attempted) await this.compose(handle, ['down', '--remove-orphans']).catch(() => {});
      if (attempted) {
        for (const volume of handle.ownedVolumes.filter(volume => !previousVolumes.has(volume))) await this.docker(spec, ['volume', 'rm', volume]).catch(() => {});
      }
      if (handle?.spec.host && handle.workspace.endsWith(`/.local/share/agent-env/${spec.owner}/${spec.name}`)) await this.command(spec, ['rm', '-rf', '--', handle.workspace]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async wait(handle) {
    const containers = new Map();
    for (const service of Object.values(handle.services)) {
      if (!containers.has(service.composeService)) {
        const ids = (await this.compose(handle, ['ps', '--all', '-q', service.composeService])).split(/\s+/).filter(Boolean);
        if (ids.length !== 1) throw new Error(`Compose service ${service.composeService} requires exactly one container.`);
        const info = JSON.parse(await this.docker(handle.spec, ['inspect', ids[0]]))[0];
        if (!info.State.Running && !(service.internal && info.State.Status === 'exited' && info.State.ExitCode === 0)) throw new Error(`Compose service ${service.composeService} is not running.`);
        if (info.State.Health && info.State.Health.Status !== 'healthy') throw new Error(`Compose service ${service.composeService} is not healthy.`);
        containers.set(service.composeService, info);
      }
      const info = containers.get(service.composeService);
      service.container = info.Id;
      if (service.internal) continue;
      const ports = info.NetworkSettings.Ports[`${service.containerPort}/tcp`] ?? [];
      if (ports.length !== 1 || ports[0].HostIp !== '127.0.0.1' || !Number(ports[0].HostPort)) throw new Error('Compose did not publish an isolated loopback port.');
      service.hostPort = Number(ports[0].HostPort);
    }
    const routed = Object.fromEntries(Object.entries(handle.services).filter(([, service]) => !service.internal));
    try { await super.wait({ ...handle, services: routed }); }
    catch (error) { throw Object.assign(new Error(await this.redact(handle, error.message)), { exitCode: error.exitCode ?? 1 }); }
  }
  connect(handle) {
    return super.connect({ ...handle, services: Object.fromEntries(Object.entries(handle.services).filter(([, service]) => !service.internal)) });
  }
  async start(handle) {
    await this.sync(handle);
    await this.compose(handle, ['up', '-d', '--build', '--wait', '--wait-timeout', String(handle.spec.startupTimeoutSeconds ?? 60)]);
    await this.wait(handle);
  }
  stop(handle) { return this.compose(handle, ['stop', '-t', '5']); }
  async remove(handle, purge = false) {
    if (handle.removed) {
      if (!purge) return;
      const volumes = [];
      for (const name of handle.ownedVolumes ?? []) {
        if (!name.startsWith(`${this.prefix(handle.spec)}-`)) throw new Error('Refusing to remove a volume outside this instance.');
        const found = (await this.docker(handle.spec, ['volume', 'ls', '-q', '--filter', `name=${name}`])).split(/\s+/);
        if (!found.includes(name)) continue;
        const [volume] = JSON.parse(await this.docker(handle.spec, ['volume', 'inspect', name]));
        if (volume.Name !== name || volume.Labels?.['agent-env.owner'] !== handle.spec.owner || volume.Labels?.['com.docker.compose.project'] !== this.prefix(handle.spec)) throw new Error('Refusing to remove a volume with different ownership labels.');
        volumes.push(name);
      }
      if (volumes.length) await this.docker(handle.spec, ['volume', 'rm', ...volumes]);
      return;
    }
    await this.compose(handle, ['down', '--remove-orphans', ...(purge ? ['--volumes'] : [])]);
    await rm(handle.runtimeDirectory, { recursive: true, force: true });
    if (handle.spec.host && handle.workspace.endsWith(`/.local/share/agent-env/${handle.spec.owner}/${handle.spec.name}`)) await this.command(handle.spec, ['rm', '-rf', '--', handle.workspace]);
  }
  async redact(handle, output) {
    return redactEnvironment(output, JSON.parse(await readFile(join(handle.runtimeDirectory, 'redactions.json'), 'utf8')));
  }
  async logs(handle, name) {
    try { return await this.redact(handle, await super.logs(handle, name)); }
    catch { throw new Error('Cannot read Compose logs. Check service status and private runtime files.'); }
  }
  async exec(handle, name, command) {
    try { return await this.redact(handle, await super.exec(handle, name, command)); }
    catch (error) { throw Object.assign(new Error(await this.redact(handle, error.message)), { exitCode: error.exitCode ?? 1 }); }
  }
  fork() { throw new Error('Compose volume forks require snapshot support. Use a new instance for an empty isolated stack.'); }
}
