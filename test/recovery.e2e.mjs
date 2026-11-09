import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { docker, fixture, freePort, until } from './lifecycle-helpers.mjs';
import { run } from './helpers.mjs';

async function scenario(name, check) {
  const test = await fixture(`recovery-${name}`);
  try {
    await test.initializeDocker();
    test.addName(name);
    await check(test, name);
    console.log(`PASS: ${name}.`);
  } finally { await test.cleanup(); }
}

async function journals(test) {
  const results = [];
  for (const directory of (await readdir(test.home)).filter(name => name.startsWith('allocation-'))) {
    for (const entry of await readdir(join(test.home, directory))) results.push(join(test.home, directory, entry));
  }
  return results;
}

for (const failure of [false, true]) {
  await scenario(`anonymous-${failure ? 'failed-start' : 'direct-purge'}`, async (test, name) => {
    const port = await freePort();
    await writeFile(join(test.cwd, 'Dockerfile'), 'FROM busybox:1.37\nVOLUME /image-cache\n');
    await writeFile(join(test.cwd, 'compose.yaml'), JSON.stringify({ services: { web: {
      build: '.', ports: [`${port}:8080`], volumes: ['.:/workspace', '/cache', 'data:/data'],
      command: ['sh', '-c', `touch /workspace/entered; while [ ! -f /workspace/release ]; do sleep 0.1; done; ${failure ? 'exit 1' : 'httpd -f -p 8080'}`],
    } }, volumes: { data: {} } }));
    await writeFile(join(test.cwd, 'agent-env.json'), JSON.stringify({ provider: 'compose' }));
    // This separate container creates an unrelated anonymous volume without labels.
    const unrelated = await docker(['create', '-v', '/unrelated', 'busybox:1.37', 'sleep', '300']);
    const [foreign] = JSON.parse(await docker(['inspect', unrelated]));
    const foreignVolume = foreign.Mounts.find(mount => mount.Destination === '/unrelated').Name;
    try {
      const pending = test.start(['up', '--name', name, '--timeout', '30']);
      await until(() => readFile(join(test.cwd, 'entered')).then(() => true, () => false), 60000);
      const resources = await test.inventory();
      const [container] = resources.filter(resource => resource.kind === 'container');
      const [info] = JSON.parse(await docker(['inspect', container.id]));
      const anonymous = info.Mounts.filter(mount => ['/cache', '/image-cache'].includes(mount.Destination)).map(mount => mount.Name);
      assert.equal(anonymous.length, 2);
      for (const id of anonymous) assert.ok(resources.some(resource => resource.kind === 'volume' && resource.id === id));
      if (failure) {
        await writeFile(join(test.cwd, 'release'), 'release');
        assert.notEqual((await pending.done).code, 0);
        assert.deepEqual(await test.cli(['list']), []);
      } else {
        await test.killDaemon();
        assert.notEqual((await pending.done).code, 0);
        await test.settleAllocation();
        await test.cli(['rm', name, '--purge']);
      }
      for (const id of anonymous) assert.ok(!(await docker(['volume', 'ls', '-q'])).split('\n').includes(id));
      await test.assertEmpty();
      assert.equal(JSON.parse(await docker(['volume', 'inspect', foreignVolume]))[0].Name, foreignVolume);
    } finally { await docker(['rm', '-fv', unrelated]); }
  });
}

const sshHost = process.env.AGENT_ENV_TEST_RECOVERY_SSH;
const sshConfig = process.env.AGENT_ENV_TEST_RECOVERY_SSH_CONFIG;
const sshOptions = sshHost ? ['--ssh', sshHost, ...(sshConfig ? ['--ssh-config', sshConfig] : [])] : [];
const ssh = command => run('ssh', [...(sshConfig ? ['-F', sshConfig] : []), '-o', 'BatchMode=yes', '--', sshHost, command]);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
if (sshHost) assert.equal(await ssh("docker info --format '{{.ID}}'"), await docker(['info', '--format', '{{.ID}}']), 'Recovery SSH tests require the same Docker engine as the local mount inventory.');

for (const remote of sshHost ? [false, true] : [false]) for (const recovery of remote ? ['purge', 'up'] : ['purge', 'up', 'lost-worker']) {
  await scenario(`slow-build-${remote ? 'ssh-' : ''}${recovery}`, async (test, name) => {
    const marker = `build-entered-${randomUUID()}`;
    const privateValue = `private-environment-${randomUUID()}`;
    const port = await freePort();
    const dockerfile = join(test.cwd, 'Dockerfile');
    const build = `FROM busybox:1.37\nRUN echo ${marker} && sleep 25\n`;
    await writeFile(dockerfile, recovery === 'lost-worker' ? 'FROM busybox:1.37\n' : build);
    await writeFile(join(test.cwd, 'compose.yaml'), JSON.stringify({ services: { web: {
      build: '.', ports: [`${port}:8080`], command: ['httpd', '-f', '-p', '8080'], environment: { RECOVERY_TOKEN: privateValue },
      volumes: ['data:/data'],
    } }, volumes: { data: {} } }));
    await writeFile(join(test.cwd, 'agent-env.json'), JSON.stringify({ provider: 'compose' }));
    if (recovery === 'lost-worker') {
      await test.cli(['up', '--name', name]);
      await test.cli(['exec', name, '--', 'sh', '-c', 'printf retained > /data/proof']);
      await writeFile(dockerfile, build);
    }
    const pending = test.start(['up', '--name', name, '--timeout', '60', ...(remote ? sshOptions : [])]);
    let journal;
    await until(async () => {
      for (const path of await journals(test)) {
        const output = await readFile(join(path, 'output.log'), 'utf8').catch(() => '');
        if (new RegExp(`\\d+(?:\\.\\d+)? ${marker}\\r?\\n`).test(output)) { journal = path; return true; }
      }
      return false;
    }, 60000);
    const identity = JSON.parse(await readFile(join(journal, 'identity.json'), 'utf8'));
    assert.ok(!JSON.stringify(identity).includes(privateValue), 'Allocation identities must not copy resolved service environments.');
    assert.equal((await run('ps', ['-p', String(identity.pid), '-o', 'lstart=', '-o', 'args='])).trim(), identity.process);
    const processes = await run('ps', ['-axo', 'pid=,ppid=,args=']);
    assert.ok(processes.split('\n').some(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match && Number(match[2]) === identity.pid && (remote ? match[3].includes('ssh ') : match[3].includes('docker compose')) && match[3].includes(remote ? "'create' '--build'" : 'create --build');
    }), 'The verified worker must own the real Compose build process.');
    if (recovery === 'lost-worker') {
      // Kill only the worker whose exact identity this fixture just verified.
      process.kill(identity.pid, 'SIGKILL');
      const failed = await pending.done;
      assert.notEqual(failed.code, 0);
      assert.match(failed.stderr, /completion is uncertain/);
      assert.equal((await test.cli(['list']))[0].recovery, 'required');
      const active = await test.invoke(['rm', name, '--accept-uncertain'], false);
      assert.notEqual(active.code, 0);
      assert.match(active.stderr, /still running/);
      // Let the real Compose child finish. An acknowledgement must not bypass it.
      await until(async () => !(await run('ps', ['-axo', 'pgid='])).split(/\s+/).includes(String(identity.pid)), 90000);
      for (const args of [['rm', name, '--purge'], ['up', name]]) {
        const refused = await test.invoke(args, false);
        assert.notEqual(refused.code, 0);
        assert.match(refused.stderr, /completion is uncertain/);
        assert.ok(refused.stderr.includes(journal));
      }
      const [owned] = (await test.inventory()).filter(resource => resource.kind === 'container');
      await docker(['rm', '-f', owned.id]);
      const foreign = await docker(['run', '-d', '--name', owned.name, '--label', `agent-env.owner=${identity.owner}`, '--label', `agent-env.instance=${name}`, '--label', 'agent-env.record=foreign', 'busybox:1.37', 'sleep', '300']);
      try {
        const refused = await test.invoke(['rm', name, '--purge', '--accept-uncertain'], false);
        assert.notEqual(refused.code, 0);
        assert.match(refused.stderr, /Refusing foreign container/);
        assert.equal(JSON.parse(await docker(['inspect', foreign]))[0].State.Running, true);
        await assert.rejects(readFile(join(journal, 'result.json')), { code: 'ENOENT' });
      } finally { await docker(['rm', '-fv', foreign]); }
      await test.cli(['rm', name, '--accept-uncertain']);
      await test.cli(['up', '--name', name]);
      assert.equal((await test.cli(['exec', name, '--', 'cat', '/data/proof'])).output, 'retained');
      await test.cli(['rm', name, '--purge']);
      await test.assertEmpty();
      assert.ok(!(await readdir(test.home)).some(entry => entry.startsWith('allocation-')));
      return;
    }
    // killDaemon verifies the private socket owner and installed daemon command.
    await test.killDaemon();
    assert.notEqual((await pending.done).code, 0);
    for (const args of [['rm', name, '--purge'], ['up', name]]) {
      const result = await test.invoke(args, false);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Allocation command is still running/);
      assert.equal((await test.cli(['list']))[0].recovery, 'required');
      assert.equal(JSON.parse(await readFile(join(test.home, 'state.json'), 'utf8')).instances[name].allocation.record, identity.record);
    }
    await test.settleAllocation();
    if (recovery === 'up') {
      await test.cli(['up', name, '--timeout', '60']);
      assert.equal((await test.cli(['list']))[0].connected, true);
    }
    await test.cli(['rm', name, '--purge']);
    await test.assertEmpty();
    // Observe Docker after success. Runtime safety depends on receipts, not this interval.
    const since = Math.floor(Date.now() / 1000);
    await docker(['events', '--since', String(since), '--until', String(since + 3), '--filter', `label=agent-env.instance=${name}`]);
    await test.assertEmpty();
  });
}

for (const mode of ['remove', 'environment']) {
  await scenario(`anonymous-retained-${mode}`, async (test, name) => {
    const compose = { services: { web: {
      image: 'busybox:1.37', ports: [`${await freePort()}:8080`], volumes: ['/cache'],
      command: ['httpd', '-f', '-p', '8080'], environment: { APP_MODE: 'before' },
    } } };
    await writeFile(join(test.cwd, 'compose.yaml'), JSON.stringify(compose));
    await writeFile(join(test.cwd, 'agent-env.json'), JSON.stringify({ provider: 'compose' }));
    await test.cli(['up', '--name', name]);
    const [container] = (await test.inventory()).filter(resource => resource.kind === 'container');
    const [info] = JSON.parse(await docker(['inspect', container.id]));
    const volume = info.Mounts.find(mount => mount.Destination === '/cache').Name;
    await test.cli(['exec', name, '--', 'sh', '-c', 'printf retained-anonymous > /cache/proof']);
    if (mode === 'environment') {
      compose.services.web.environment.APP_MODE = 'after';
      await writeFile(join(test.cwd, 'compose.yaml'), JSON.stringify(compose));
      await test.cli(['up', '--name', name]);
      await test.inventory();
      await test.cli(['rm', name, '--purge']);
    } else await test.cli(['rm', name]);
    assert.equal(await docker(['run', '--rm', '--mount', `type=volume,src=${volume},dst=/cache,readonly`, 'busybox:1.37', 'cat', '/cache/proof']), 'retained-anonymous');
    // This intentionally retained ID came from this fixture's owned container.
    await docker(['volume', 'rm', volume]);
    await test.assertEmpty();
  });
}

if (sshHost) for (const provider of ['docker', 'compose']) for (const foreign of [false, true]) {
  await scenario(`ssh-${provider}-failed-start-${foreign ? 'foreign' : 'clean'}`, async (test, name) => {
    const port = await freePort();
    const command = 'touch /workspace/entered; while [ ! -f /workspace/release ]; do sleep 0.1; done; exit 1';
    await writeFile(join(test.cwd, 'agent-env.json'), JSON.stringify(provider === 'docker' ? { services: { web: {
      image: 'busybox:1.37', port, containerPort: 8080, volumes: { data: '/data' }, command,
    } } } : { provider: 'compose' }));
    if (provider === 'compose') await writeFile(join(test.cwd, 'compose.yaml'), JSON.stringify({ services: { web: {
      image: 'busybox:1.37', ports: [`${port}:8080`], command: ['sh', '-c', command], volumes: ['.:/workspace', 'data:/data'],
    } }, volumes: { data: {} } }));
    const pending = test.start(['up', '--name', name, '--timeout', '5', ...sshOptions]);
    let handle;
    await until(async () => {
      handle = JSON.parse(await readFile(join(test.home, 'state.json'), 'utf8')).instances[name];
      return handle && ssh(`test -f ${quote(join(handle.workspace, 'entered'))}`).then(() => true, () => false);
    }, 60000);
    const [owned] = (await test.inventory()).filter(resource => resource.kind === 'container');
    let replacement;
    try {
      if (foreign) {
        await docker(['rm', '-fv', owned.id]);
        replacement = await docker(['run', '-d', '--name', owned.name, '--label', `agent-env.owner=${handle.spec.owner}`, '--label', `agent-env.instance=${name}`, '--label', 'agent-env.record=foreign', 'busybox:1.37', 'sleep', '300']);
      } else await ssh(`touch ${quote(join(handle.workspace, 'release'))}`);
      const failed = await pending.done;
      assert.notEqual(failed.code, 0);
      if (foreign) {
        assert.match(failed.stderr, /Cleanup failed: Refusing foreign container/);
        assert.equal((await test.cli(['list']))[0].recovery, 'required');
        await ssh(`test -d ${quote(handle.workspace)}`);
        assert.equal(JSON.parse(await docker(['inspect', replacement]))[0].State.Running, true);
        await docker(['rm', '-fv', replacement]);
        replacement = null;
        await test.cli(['rm', name, '--purge']);
      } else assert.deepEqual(await test.cli(['list']), []);
      await ssh(`test ! -e ${quote(handle.workspace)}`);
      await test.assertEmpty();
    } finally { if (replacement) await docker(['rm', '-fv', replacement]); }
  });
}

if (sshHost) await scenario('ssh-compose-workspace-cleanup-denied', async (test, name) => {
  await writeFile(join(test.cwd, 'agent-env.json'), JSON.stringify({ provider: 'compose' }));
  await writeFile(join(test.cwd, 'compose.yaml'), JSON.stringify({ services: { web: {
    image: 'busybox:1.37', ports: [`${await freePort()}:8080`], volumes: ['.:/workspace'],
    environment: { TEST_TOKEN: `private-fixture-${randomUUID()}` },
    command: ['sh', '-c', 'touch /workspace/entered; while [ ! -f /workspace/release ]; do sleep 0.1; done; exit 1'],
  } } }));
  const pending = test.start(['up', '--name', name, '--timeout', '30', ...sshOptions]);
  let handle, parent;
  try {
    await until(async () => {
      handle = JSON.parse(await readFile(join(test.home, 'state.json'), 'utf8')).instances[name];
      return handle && ssh(`test -f ${quote(join(handle.workspace, 'entered'))}`).then(() => true, () => false);
    }, 60000);
    assert.ok(handle.workspace.endsWith(`/.local/share/agent-env/${handle.spec.owner}/${name}`));
    parent = dirname(handle.workspace);
    // Deny deletion of this fixture's workspace through real filesystem permissions.
    await ssh(`chmod 500 ${quote(parent)}`);
    await ssh(`touch ${quote(join(handle.workspace, 'release'))}`);
    const failed = await pending.done;
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /Cleanup failed/);
    assert.equal((await test.cli(['list']))[0].recovery, 'required');
    await ssh(`test -d ${quote(handle.workspace)}`);
  } finally { if (parent) await ssh(`chmod 700 ${quote(parent)}`); }
  await test.cli(['rm', name, '--purge']);
  await ssh(`test ! -e ${quote(handle.workspace)}`);
  await test.assertEmpty();
});
