import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import net from 'node:net';
import { createCli, docker, fixture, freePort, requestHttp, until } from './helpers.mjs';

// This suite requires the real, installed agent-env package with parent integration.
if (!process.env.AGENT_ENV_CLI || !isAbsolute(process.env.AGENT_ENV_CLI)) throw new Error('Set AGENT_ENV_CLI to an absolute installed agent-env executable path.');
if (process.env.AGENT_ENV_TEST_SSH) throw new Error('Run the Dev Container suite against local Docker.');
const test = await fixture('devcontainer');
const { cwd, home } = test;
const port = await freePort(), sidePort = await freePort(), occupiedPort = await freePort();
const occupied = net.createServer();
await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(occupiedPort, '127.0.0.1', resolve); });
const roots = {};
let owner;
const invokeFor = directory => createCli(directory, home);
const exec = async (name, argv, service = 'workspace') => (await test.cli(['exec', name, '--service', service, '--', ...argv])).output;
const owned = async kind => {
  if (!owner) return [];
  const ids = (await docker([kind, 'ls', ...(kind === 'container' ? ['-aq'] : ['-q']), '--filter', `label=agent-env.owner=${owner}`])).split(/\s+/).filter(Boolean);
  return ids.length ? JSON.parse(await docker([kind, 'inspect', ...new Set(ids)])) : [];
};
const up = async (variant, name, extra = []) => {
  return invokeFor(roots[variant]).cli(['up', '--name', name, '--no-watch', ...extra]);
};
async function setup(variant, configuration, extra = {}) {
  const directory = join(cwd, variant);
  roots[variant] = directory;
  await mkdir(join(directory, '.devcontainer'), { recursive: true });
  const source = `// JSONC source remains unchanged.\n${JSON.stringify(configuration, null, 2).replace(/\n}$/, ',\n}')}\n`;
  await writeFile(join(directory, '.devcontainer', 'devcontainer.json'), source);
  await writeFile(join(directory, 'server.mjs'), `import http from 'node:http';\nhttp.createServer((q,r)=>r.end('devcontainer-http')).listen(${port}, '0.0.0.0');\n`);
  await writeFile(join(directory, 'agent-env.json'), JSON.stringify({ provider: 'devcontainer', startupTimeoutSeconds: 30, ...extra }));
  return source;
}
async function assertHttp(name, expected = 'devcontainer-http') {
  await until(async () => {
    const response = await requestHttp(`http://127.0.0.1:${port}`, { headers: { host: `${name}.localhost` } });
    assert.equal(response.status, 200);
    assert.equal(response.body, expected);
    return true;
  });
}
try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  await docker(['compose', 'version']);
  const base = {
    image: 'node:22-bookworm-slim', remoteUser: 'node', updateRemoteUserUID: false,
    forwardPorts: [port], remoteEnv: { E2E_REMOTE: 'native-environment' },
    portsAttributes: { [port]: { protocol: 'http' } },
    mounts: ['type=volume,source=shared-source-name,target=/data'],
    initializeCommand: 'printf initialize > initialize-marker',
    onCreateCommand: 'printf create > create-marker',
    updateContentCommand: 'printf content > content-marker',
    postCreateCommand: 'printf post-create > post-create-marker',
    postStartCommand: `node --watch server.mjs >/tmp/devcontainer-server.log 2>&1 &`,
    postAttachCommand: 'printf attach > attach-marker',
  };
  const imageSource = await setup('image', base);
  await up('image', 'dc-alpha');
  owner = JSON.parse(await readFile(join(home, 'state.json'), 'utf8')).owner;
  await assertHttp('dc-alpha');
  const serverSource = await readFile(join(roots.image, 'server.mjs'), 'utf8');
  await writeFile(join(roots.image, 'server.mjs'), serverSource.replace('devcontainer-http', 'hot-update'));
  await until(async () => { await assertHttp('dc-alpha', 'hot-update'); return true; });
  await writeFile(join(roots.image, 'server.mjs'), serverSource);
  await until(async () => { await assertHttp('dc-alpha'); return true; });
  await writeFile(join(roots.image, 'agent-env.json'), JSON.stringify({ provider: 'devcontainer', commands: { test: ['id', '-un'] } }));
  await up('image', 'dc-alpha', ['--timeout', '30']);
  assert.equal((await test.cli(['run', 'dc-alpha', 'test'])).output, 'node');
  assert.equal(await exec('dc-alpha', ['id', '-un']), 'node');
  assert.equal(await exec('dc-alpha', ['printenv', 'E2E_REMOTE']), 'native-environment');
  assert.equal(await exec('dc-alpha', ['pwd']), `/workspaces/image`);
  await writeFile(join(roots.image, 'live-marker'), 'local-bind');
  await test.cli(['sync', 'dc-alpha']);
  assert.equal(await exec('dc-alpha', ['cat', 'live-marker']), 'local-bind');
  await test.cli(['logs', 'dc-alpha', '--service', 'workspace']);
  assert.equal(await exec('dc-alpha', ['printf', '%s', 'literal $HOME; value']), 'literal $HOME; value');
  for (const marker of ['initialize', 'create', 'content', 'post-create', 'attach']) assert.ok((await readFile(join(roots.image, `${marker}-marker`), 'utf8')).length);
  assert.equal(await readFile(join(roots.image, '.devcontainer/devcontainer.json'), 'utf8'), imageSource);
  assert.equal((await readdir(join(roots.image, '.devcontainer'))).includes('.devcontainer-lock.json'), false);
  const alphaContainer = (await owned('container')).find(info => info.Config.Labels['agent-env.instance'] === 'dc-alpha');
  const publication = alphaContainer.NetworkSettings.Ports[`${port}/tcp`];
  assert.equal(publication.length, 1);
  assert.equal(publication[0].HostIp, '127.0.0.1');
  assert.notEqual(Number(publication[0].HostPort), port);
  const alphaVolume = alphaContainer.Mounts.find(mount => mount.Destination === '/data').Name;
  // Named data persists. Use root only for this synthetic storage write.
  await docker(['exec', alphaContainer.Id, 'sh', '-c', 'printf retained >/data/value']);
  await up('image', 'dc-beta');
  const betaContainer = (await owned('container')).find(info => info.Config.Labels['agent-env.instance'] === 'dc-beta');
  assert.notEqual(betaContainer.Id, alphaContainer.Id);
  assert.notEqual(betaContainer.Mounts.find(mount => mount.Destination === '/data').Name, alphaVolume);
  await assertHttp('dc-beta');
  assert.equal(await exec('dc-alpha', ['cat', '/data/value']), 'retained');
  await test.cli(['down', 'dc-alpha']);
  await test.cli(['up', 'dc-alpha']);
  await assertHttp('dc-alpha');
  assert.equal(await exec('dc-alpha', ['cat', '/data/value']), 'retained');
  await test.cli(['rm', 'dc-alpha']);
  assert.ok(await docker(['volume', 'ls', '-q', '--filter', `name=^${alphaVolume}$`]));
  await up('image', 'dc-alpha');
  assert.equal(await exec('dc-alpha', ['cat', '/data/value']), 'retained');
  const failure = await test.invoke(['exec', 'dc-alpha', '--service', 'workspace', '--', 'sh', '-c', 'printf dc-stdout; printf dc-stderr >&2; exit 17'], false);
  assert.equal(failure.code, 17);
  assert.match(failure.stderr, /dc-stdout/);
  assert.match(failure.stderr, /dc-stderr/);
  await test.cli(['rm', 'dc-alpha', '--purge']);
  assert.equal(await docker(['volume', 'ls', '-q', '--filter', `name=^${alphaVolume}$`]), '');
  await assertHttp('dc-beta');
  await test.cli(['daemon', 'stop']);
  await test.cli(['list']);
  await assertHttp('dc-beta');
  assert.equal(await exec('dc-beta', ['id', '-un']), 'node');
  await test.cli(['rm', 'dc-beta', '--purge']);

  const dockerfile = { ...base, build: { dockerfile: 'Dockerfile' } };
  delete dockerfile.image;
  const dockerfileSource = await setup('dockerfile', dockerfile);
  await writeFile(join(roots.dockerfile, '.devcontainer/Dockerfile'), 'FROM node:22-bookworm-slim\nRUN printf built >/image-marker\n');
  await up('dockerfile', 'dc-build');
  assert.equal(await exec('dc-build', ['cat', '/image-marker']), 'built');
  await assertHttp('dc-build');
  assert.equal(await readFile(join(roots.dockerfile, '.devcontainer/devcontainer.json'), 'utf8'), dockerfileSource);
  await test.cli(['rm', 'dc-build', '--purge']);

  await setup('lazy', { image: base.image, forwardPorts: [port], portsAttributes: { [port]: { protocol: 'http' } } }, {
    startupTimeoutSeconds: 2, commands: { start: 'nohup node server.mjs >/tmp/lazy-server.log 2>&1 </dev/null &' },
  });
  await up('lazy', 'dc-lazy');
  assert.ok((await test.cli(['list'])).some(instance => instance.name === 'dc-lazy'));
  assert.equal((await requestHttp(`http://127.0.0.1:${port}`, { headers: { host: 'dc-lazy.localhost' } })).status, 502);
  await test.cli(['run', 'dc-lazy', 'start']);
  await assertHttp('dc-lazy');
  await test.cli(['rm', 'dc-lazy', '--purge']);

  const tcpPort = await freePort();
  await setup('tcp', { image: base.image, updateRemoteUserUID: false, forwardPorts: [tcpPort], postStartCommand: 'node tcp.cjs >/tmp/tcp.log 2>&1 &' });
  await writeFile(join(roots.tcp, 'tcp.cjs'), `require('node:net').createServer(s=>s.end('raw-tcp')).listen(${tcpPort}, '0.0.0.0');`);
  const tcp = await up('tcp', 'dc-tcp');
  assert.equal(tcp.services.workspace.protocol, 'tcp');
  const tcpResponse = await new Promise((resolve, reject) => {
    const socket = net.connect(tcpPort, '127.0.0.1');
    let body = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('TCP route timed out.')));
    socket.on('data', chunk => { body += chunk; });
    socket.on('end', () => resolve(body));
    socket.on('error', reject);
  });
  assert.equal(tcpResponse, 'raw-tcp');
  await test.cli(['rm', 'dc-tcp', '--purge']);

  await setup('auto-compose', { image: base.image });
  await writeFile(join(roots['auto-compose'], 'agent-env.json'), JSON.stringify({ compose: { routes: { web: { service: 'web', target: 8080, port, protocol: 'http' } } } }));
  await writeFile(join(roots['auto-compose'], 'compose.yaml'), `services:\n  web:\n    image: busybox:1.37\n    command: [httpd, -f, -p, "8080"]\n    ports: ["${port}:8080"]\n`);
  const autoCompose = await up('auto-compose', 'dc-auto-compose');
  assert.equal(autoCompose.provider, 'compose');
  assert.equal(autoCompose.services.web.port, port);
  assert.equal((await requestHttp(`http://127.0.0.1:${port}`, { headers: { host: 'dc-auto-compose.localhost' } })).status, 404);
  await test.cli(['rm', 'dc-auto-compose', '--purge']);

  const compose = { ...base, dockerComposeFile: '../compose.yaml', service: 'workspace', workspaceFolder: '/workspace', forwardPorts: [port] };
  delete compose.image;
  delete compose.mounts;
  const composeSource = await setup('compose', compose, { devcontainer: { routes: {
    workspace: { service: 'workspace', target: port, port, protocol: 'http' },
    side: { service: 'side', target: 8080, port: sidePort, protocol: 'http' },
  } } });
  const yaml = `services:
  workspace:
    image: node:22-bookworm-slim
    container_name: must-not-use-shared-name
    command: sleep infinity
    volumes: [".:/workspace", "data:/data"]
    ports: ["${occupiedPort}:${port}"]
  side:
    image: busybox:1.37
    command: [httpd, -f, -p, "8080"]
volumes:
  data: {name: must-not-use-shared-volume}
`;
  await writeFile(join(roots.compose, 'compose.yaml'), yaml);
  await up('compose', 'dc-compose');
  await assertHttp('dc-compose');
  assert.equal((await requestHttp(`http://127.0.0.1:${sidePort}`, { headers: { host: 'dc-compose.localhost' } })).status, 404);
  assert.equal(occupied.listening, true);
  const composeContainers = (await owned('container')).filter(info => info.Config.Labels['agent-env.instance'] === 'dc-compose');
  assert.equal(composeContainers.length, 2);
  assert.ok(composeContainers.every(info => info.Name !== '/must-not-use-shared-name'));
  const composeWorkspace = composeContainers.find(info => info.Config.Labels['com.docker.compose.service'] === 'workspace');
  await docker(['exec', composeWorkspace.Id, 'sh', '-c', 'printf compose-retained >/data/value']);
  await test.cli(['down', 'dc-compose']);
  await test.cli(['up', 'dc-compose']);
  await assertHttp('dc-compose');
  assert.equal(await exec('dc-compose', ['cat', '/data/value']), 'compose-retained');
  await test.cli(['rm', 'dc-compose']);
  await up('compose', 'dc-compose');
  assert.equal(await exec('dc-compose', ['cat', '/data/value']), 'compose-retained');
  assert.equal(await readFile(join(roots.compose, 'compose.yaml'), 'utf8'), yaml);
  assert.equal(await readFile(join(roots.compose, '.devcontainer/devcontainer.json'), 'utf8'), composeSource);
  await test.cli(['rm', 'dc-compose', '--purge']);

  const dbPort = await freePort();
  await setup('shared-network', {
    image: undefined, dockerComposeFile: '../compose.yaml', service: 'workspace', workspaceFolder: '/workspace',
    forwardPorts: [port, `db:${dbPort}`], portsAttributes: { [port]: { protocol: 'http' } },
    postStartCommand: 'node server.mjs >/tmp/shared-network.log 2>&1 &',
  });
  const sharedModel = {
    services: {
      workspace: { image: base.image, command: ['sleep', 'infinity'], network_mode: 'service:db', volumes: ['.:/workspace'], environment: { REVISION: 'first' } },
      db: { image: 'postgres:16-alpine', command: ['postgres', '-p', String(dbPort)], environment: { POSTGRES_PASSWORD: 'dummy-shared-network-password' }, volumes: ['db:/var/lib/postgresql/data'] },
    }, volumes: { db: {} },
  };
  const sharedFile = join(roots['shared-network'], 'compose.yaml');
  await writeFile(sharedFile, JSON.stringify(sharedModel));
  for (const name of ['dc-shared-a', 'dc-shared-b']) {
    const shared = await up('shared-network', name);
    assert.equal(shared.services[`port-${dbPort}`].protocol, 'tcp');
    await assertHttp(name);
    const containers = (await owned('container')).filter(info => info.Config.Labels['agent-env.instance'] === name);
    const workspace = containers.find(info => info.Config.Labels['com.docker.compose.service'] === 'workspace');
    const db = containers.find(info => info.Config.Labels['com.docker.compose.service'] === 'db');
    assert.equal(workspace.HostConfig.NetworkMode, `container:${db.Id}`);
    assert.ok(db.NetworkSettings.Ports[`${port}/tcp`].every(binding => binding.HostIp === '127.0.0.1'));
    await until(() => docker(['exec', db.Id, 'pg_isready', '-h', '127.0.0.1', '-p', String(dbPort), '-U', 'postgres']).then(() => true, () => false));
    await docker(['exec', db.Id, 'sh', '-c', 'printf retained > /var/lib/postgresql/data/agent-env-marker']);
    await test.cli(['use', name]);
    await new Promise((resolve, reject) => {
      const socket = net.connect(dbPort, '127.0.0.1', () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
      socket.setTimeout(5000, () => socket.destroy(new Error('Postgres route timed out.')));
      socket.on('data', data => { socket.destroy(); try { assert.equal(data.toString(), 'N'); resolve(); } catch (error) { reject(error); } });
      socket.on('error', reject);
    });
  }
  await test.cli(['down', 'dc-shared-a']);
  sharedModel.services.workspace.environment.REVISION = 'second';
  await writeFile(sharedFile, JSON.stringify(sharedModel));
  const staleCompose = await test.invoke(['up', 'dc-shared-a'], false);
  assert.notEqual(staleCompose.code, 0);
  assert.match(staleCompose.stderr, /Compose configuration changed/);
  await test.cli(['rm', 'dc-shared-a']);
  await up('shared-network', 'dc-shared-a');
  assert.equal(await exec('dc-shared-a', ['printenv', 'REVISION']), 'second');
  const retainedDb = (await owned('container')).find(info => info.Config.Labels['agent-env.instance'] === 'dc-shared-a' && info.Config.Labels['com.docker.compose.service'] === 'db');
  assert.equal(await docker(['exec', retainedDb.Id, 'cat', '/var/lib/postgresql/data/agent-env-marker']), 'retained');
  await assertHttp('dc-shared-b');
  for (const name of ['dc-shared-a', 'dc-shared-b']) await test.cli(['rm', name, '--purge']);

  await setup('internal', { image: base.image, remoteUser: 'node', updateRemoteUserUID: false });
  await rename(join(roots.internal, '.devcontainer/devcontainer.json'), join(roots.internal, '.devcontainer.json'));
  await rm(join(roots.internal, 'agent-env.json'));
  const internal = await up('internal', 'dc-internal');
  assert.equal(await exec('dc-internal', ['id', '-un']), 'node');
  assert.ok(Object.values(internal.services).some(service => service.internal));
  const fork = await test.invoke(['fork', 'dc-internal', 'dc-copy'], false);
  assert.notEqual(fork.code, 0);
  await test.cli(['down', 'dc-internal']);
  const snapshot = await test.invoke(['snapshot', 'dc-internal', join(test.directory, 'snapshot')], false);
  assert.notEqual(snapshot.code, 0);
  await test.cli(['rm', 'dc-internal', '--purge']);

  await setup('explicit', { image: base.image, updateRemoteUserUID: false }, { devcontainer: { config: 'custom/devcontainer.json' } });
  await mkdir(join(roots.explicit, 'custom'));
  await writeFile(join(roots.explicit, 'custom/devcontainer.json'), '{"image":"node:22-bookworm-slim", "remoteUser":"node"}');
  await up('explicit', 'dc-explicit');
  assert.equal(await exec('dc-explicit', ['id', '-un']), 'node');
  await test.cli(['rm', 'dc-explicit', '--purge']);

  const shipped = join(cwd, 'shipped');
  await cp(join(dirname(dirname(await realpath(process.env.AGENT_ENV_CLI))), 'examples/devcontainer'), shipped, { recursive: true });
  for (const variant of ['image', 'dockerfile', 'compose']) {
    const directory = join(shipped, variant);
    await writeFile(join(directory, 'agent-env.json'), JSON.stringify({ provider: 'devcontainer', devcontainer: {
      routes: { workspace: { target: 3000, port, protocol: 'http' } },
    } }));
    const name = `dc-example-${variant}`;
    await invokeFor(directory).cli(['up', '--name', name]);
    await assertHttp(name, 'Dev Container ready\n');
    assert.equal(await exec(name, ['id', '-un']), 'node');
    await test.cli(['rm', name, '--purge']);
  }

  for (const variant of ['failure-image', 'failure-compose']) {
    const config = variant === 'failure-compose' ? { ...compose } : { ...base };
    delete config.forwardPorts;
    config.postCreateCommand = 'exit 23';
    await setup(variant, config);
    if (variant === 'failure-compose') await writeFile(join(roots[variant], 'compose.yaml'), yaml);
    const result = await invokeFor(roots[variant]).invoke(['up', '--name', variant, '--no-watch'], false);
    assert.notEqual(result.code, 0);
    assert.equal((await owned('container')).filter(info => info.Config.Labels['agent-env.instance'] === variant).length, 0);
    assert.equal((await owned('volume')).filter(info => info.Labels['agent-env.instance'] === variant).length, 0);
    assert.equal((await owned('network')).filter(info => info.Labels['agent-env.instance'] === variant).length, 0);
  }
  const remote = await invokeFor(roots.internal).invoke(['up', '--name', 'dc-remote', '--ssh', 'invalid-devcontainer-host'], false);
  assert.notEqual(remote.code, 0);
  assert.match(remote.stderr, /local Docker/i);
  const cloud = await invokeFor(roots.internal).invoke(['up', '--name', 'dc-cloud', '--cloud', 'hetzner'], false);
  assert.notEqual(cloud.code, 0);
  assert.match(cloud.stderr, /local Docker/i);
  assert.equal((await owned('container')).length, 0);
  assert.equal((await owned('volume')).length, 0);
  assert.equal((await owned('network')).length, 0);
  console.log('PASS: installed CLI image, Dockerfile, Compose, JSONC, lifecycle hooks, HTTP routes, exec, isolation, persistence, purge, and failure cleanup.');
} finally {
  await new Promise(resolve => occupied.close(resolve));
  await test.cleanup();
}
