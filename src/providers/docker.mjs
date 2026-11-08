import http from 'node:http';
import { spawn } from 'node:child_process';
import { run, quote, freePort, reachable, delay } from '../system.mjs';
import { home } from '../paths.mjs';
import { hash } from '../config.mjs';
import { join } from 'node:path';
import { sourceExclusions } from '../source-paths.mjs';

// A provider owns compute and storage. The daemon owns names and local routing.
export class DockerProvider {
  sessions = new Map();
  sshArgs(spec, multiplex = true) {
    const control = join(home, `ssh-${hash(`${spec.host}:${spec.sshConfig ?? ''}`)}`);
    if (multiplex) this.sessions.set(control, spec);
    const connection = multiplex
      ? ['-o', 'ControlMaster=auto', '-S', control, '-o', 'ControlPersist=60']
      : ['-o', 'ControlMaster=no', '-S', 'none', '-o', 'ControlPersist=no'];
    return [...connection, ...(spec.sshConfig ? ['-F', spec.sshConfig] : []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'];
  }
  command(spec, args, options) {
    return spec.host
      ? run('ssh', [...this.sshArgs(spec), '--', spec.host, args.map(quote).join(' ')], options)
      : run(args[0], args.slice(1), options);
  }
  docker(spec, args, options = {}) {
    const inspect = args[0] === 'inspect' || ['container', 'image', 'volume', 'network'].includes(args[0]) && args[1] === 'inspect';
    return this.command(spec, ['docker', ...args], { ...options, ...(inspect ? { errorStdout: false } : {}) });
  }
  prefix(spec) { return `agent-env-${spec.owner}-${spec.name}`; }
  volume(spec, service, name) { return `${this.prefix(spec)}-${service}-${name}`; }
  async sync(handle) {
    const { spec, workspace } = handle;
    if (!spec.host) return;
    await this.command(spec, ['mkdir', '-p', workspace]);
    await run('rsync', ['-az', '--delete', ...sourceExclusions.map(rule => `--exclude=${rule}`), '-e', ['ssh', ...this.sshArgs(spec)].map(quote).join(' '), `${spec.cwd}/`, `${spec.host}:${quote(`${workspace}/`)}`]);
  }
  async create(spec) {
    await this.docker(spec, ['info', '--format', '{{.ServerVersion}}']);
    const workspace = spec.host ? `${await this.command(spec, ['pwd'])}/.local/share/agent-env/${spec.owner}/${spec.name}` : spec.cwd;
    if (workspace.includes(',')) throw new Error('Workspace paths cannot contain commas.');
    const handle = { spec, workspace, services: {} };
    const newVolumes = [];
    await this.sync(handle);
    const network = this.prefix(spec);
    await this.docker(spec, ['network', 'create', '--label', `agent-env.owner=${spec.owner}`, network]);
    try {
      for (const [name, service] of Object.entries(spec.services)) {
        const container = `${network}-${name}`;
        const args = ['run', '-d', '--init', '--name', container, '--label', `agent-env.owner=${spec.owner}`, '--network', network, '--network-alias', name, '-p', `127.0.0.1::${service.containerPort}`, '--mount', `type=bind,src=${workspace},dst=/workspace`, '-w', '/workspace'];
        for (const [volume, target] of Object.entries(service.volumes ?? {})) {
          const volumeName = this.volume(spec, name, volume);
          const exists = await this.docker(spec, ['volume', 'ls', '-q', '--filter', `name=^${volumeName}$`]);
          if (!exists) newVolumes.push(volumeName);
          await this.docker(spec, ['volume', 'create', '--label', `agent-env.owner=${spec.owner}`, volumeName]);
          args.push('--mount', `type=volume,src=${this.volume(spec, name, volume)},dst=${target}`);
        }
        for (const [key, value] of Object.entries({ HOST: '0.0.0.0', PORT: String(service.containerPort), ...service.env })) args.push('-e', `${key}=${value}`);
        args.push(service.image);
        if (service.command) args.push('sh', '-lc', service.command);
        // Record the name before creation so partial failures can remove it.
        handle.services[name] = { container, ...service };
        await this.docker(spec, args);
      }
      await this.wait(handle);
      return handle;
    } catch (error) {
      await this.remove(handle).catch(() => {});
      for (const volume of newVolumes) await this.docker(spec, ['volume', 'rm', volume]).catch(() => {});
      throw error;
    }
  }
  async wait(handle, deadline = Date.now() + (handle.spec.startupTimeoutSeconds ?? 60) * 1000) {
    const seconds = handle.spec.startupTimeoutSeconds ?? 60;
    for (const [name, service] of Object.entries(handle.services)) {
      while (true) {
        const info = JSON.parse(await this.docker(handle.spec, ['inspect', service.container]))[0];
        if (!info.State.Running) {
          const logs = await this.docker(handle.spec, ['logs', '--tail', '20', service.container], { combined: true }).catch(() => '');
          throw new Error(`${name} exited. ${logs}`);
        }
        const published = info.NetworkSettings.Ports[`${service.containerPort}/tcp`]?.[0];
        if (published) {
          service.hostPort = Number(published.HostPort);
          let ready = handle.spec.host
            ? await this.command(handle.spec, ['bash', '-c', `timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${service.hostPort}'`]).then(() => true, () => false)
            : await reachable(service.hostPort);
          if (ready && service.protocol === 'http') {
            ready = handle.spec.host
              ? await this.command(handle.spec, ['bash', '-c', `timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${service.hostPort}; printf \"GET / HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n\" >&3; IFS= read -r line <&3; [[ $line == HTTP/* ]]'`]).then(() => true, () => false)
              : await new Promise(resolve => {
                const req = http.get({ host: '127.0.0.1', port: service.hostPort, path: '/' }, res => { res.resume(); resolve(true); });
                req.setTimeout(1000, () => req.destroy());
                req.on('error', () => resolve(false));
              });
          }
          if (ready && service.health) ready = await this.docker(handle.spec, ['exec', service.container, 'sh', '-lc', service.health]).then(() => true, () => false);
          if (ready) break;
        }
        if (Date.now() > deadline) throw new Error(`${name} did not open its port within ${seconds} seconds. Bind the service to 0.0.0.0.`);
        await delay(300);
      }
    }
  }
  async connect(handle) {
    const connections = [];
    try {
      for (const [name, service] of Object.entries(handle.services)) {
        if (!handle.spec.host) { connections.push({ name, backendPort: service.hostPort, close() {} }); continue; }
        const port = await freePort();
        const child = spawn('ssh', [...this.sshArgs(handle.spec, false), '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${port}:127.0.0.1:${service.hostPort}`, '--', handle.spec.host], { stdio: ['ignore', 'ignore', 'pipe'] });
        let error = '';
        child.stderr.on('data', data => { error += data; });
        child.on('error', value => { error += value.message; });
        connections.push({ name, backendPort: port, child, close() { child.kill('SIGTERM'); } });
        const deadline = Date.now() + 12000;
        while (!await reachable(port)) {
          if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`SSH forwarding failed: ${error}`);
          await delay(100);
        }
      }
      return connections;
    } catch (error) { for (const connection of connections) connection.close(); throw error; }
  }
  async start(handle) {
    await this.sync(handle);
    for (const service of Object.values(handle.services)) await this.docker(handle.spec, ['start', service.container]);
    await this.wait(handle);
  }
  async stop(handle) {
    await Promise.all(Object.values(handle.services).map(service => this.docker(handle.spec, ['stop', '-t', '5', service.container])));
  }
  async remove(handle, purge = false) {
    for (const service of Object.values(handle.services)) {
      const exists = await this.docker(handle.spec, ['container', 'ls', '-aq', '--filter', `name=^/${service.container}$`]);
      if (exists) await this.docker(handle.spec, ['rm', '-f', service.container]);
    }
    const network = this.prefix(handle.spec);
    const networkExists = await this.docker(handle.spec, ['network', 'ls', '-q', '--filter', `name=^${network}$`]);
    if (networkExists) await this.docker(handle.spec, ['network', 'rm', network]);
    if (handle.spec.host && handle.workspace.endsWith(`/.local/share/agent-env/${handle.spec.owner}/${handle.spec.name}`)) {
      await this.command(handle.spec, ['rm', '-rf', '--', handle.workspace]);
    }
    if (purge) {
      for (const [name, service] of Object.entries(handle.services)) {
        for (const volume of Object.keys(service.volumes ?? {})) {
          const volumeName = this.volume(handle.spec, name, volume);
          const exists = await this.docker(handle.spec, ['volume', 'ls', '-q', '--filter', `name=^${volumeName}$`]);
          if (exists) await this.docker(handle.spec, ['volume', 'rm', volumeName]);
        }
      }
    }
  }
  async dispose() {
    await Promise.all([...this.sessions.values()].map(spec =>
      run('ssh', [...this.sshArgs(spec), '-O', 'exit', '--', spec.host]).catch(() => {})));
    this.sessions.clear();
  }
  async status(handle) {
    return Object.fromEntries(await Promise.all(Object.entries(handle.services).map(async ([name, service]) => {
      const result = await this.docker(handle.spec, ['inspect', '--format', '{{.State.Status}}', service.container]).catch(() => 'unreachable');
      return [name, result];
    })));
  }
  logs(handle, name) { return this.docker(handle.spec, ['logs', '--tail', '100', handle.services[name].container], { combined: true }); }
  exec(handle, name, command) { return this.docker(handle.spec, ['exec', handle.services[name].container, ...command], { combined: true }); }
  async fork(handle, spec) {
    const volumes = Object.entries(handle.services).flatMap(([name, service]) =>
      Object.keys(service.volumes ?? {}).map(volume => ({ source: this.volume(handle.spec, name, volume), destination: this.volume(spec, name, volume) })));
    for (const { destination } of volumes) {
      const existing = await this.docker(spec, ['volume', 'ls', '-q', '--filter', `name=^${destination}$`]);
      if (existing) throw new Error(`Volume ${destination} already exists. Choose a different fork name.`);
    }
    const created = [];
    try {
      for (const { source, destination } of volumes) {
        await this.docker(spec, ['volume', 'create', '--label', `agent-env.owner=${spec.owner}`, destination]);
        created.push(destination);
        await this.docker(spec, ['run', '--rm', '--mount', `type=volume,src=${source},dst=/source,readonly`, '--mount', `type=volume,src=${destination},dst=/destination`, 'alpine:3', 'sh', '-c', 'cp -a /source/. /destination/']);
      }
      return await this.create(spec);
    } catch (error) {
      for (const volume of created) await this.docker(spec, ['volume', 'rm', volume]).catch(() => {});
      throw error;
    }
  }
}
