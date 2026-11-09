import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { docker, fixture, freePort, requestHttp, until } from './lifecycle-helpers.mjs';

async function project(test, provider = 'docker', gated = false) {
  const port = await freePort();
  const command = `${gated ? 'if [ ! -f /data/proof ]; then printf startup-value > /data/proof; fi; touch /workspace/entered; while [ ! -f /workspace/release ]; do sleep 0.1; done; ' : ''}httpd -f -p 8080 -h /data`;
  const service = { image: 'busybox:1.37', port, containerPort: 8080, command, volumes: { data: '/data' } };
  if (provider === 'docker') {
    await writeFile(join(test.cwd, 'agent-env.json'), JSON.stringify({ services: { web: service } }));
  } else {
    await writeFile(join(test.cwd, 'Dockerfile'), 'FROM busybox:1.37\n');
    await writeFile(join(test.cwd, 'compose.yaml'), JSON.stringify({ services: { web: {
      build: '.', command: ['sh', '-c', command], ports: [`${port}:8080`],
      volumes: ['.:/workspace', 'data:/data'],
    } }, volumes: { data: {} } }));
    await writeFile(join(test.cwd, 'agent-env.json'), JSON.stringify({ provider: 'compose' }));
  }
  return port;
}

async function route(port, name, expected) {
  const response = await requestHttp(`http://127.0.0.1:${port}/proof`, { headers: { host: `${name}.localhost:${port}` } });
  assert.equal(response.status, 200);
  assert.equal(response.body, expected);
}

async function containers(test, name) {
  return (await test.inventory()).filter(record => record.kind === 'container' && (record.name === `${test.prefix(name)}-web` || record.labels['com.docker.compose.project'] === test.prefix(name)));
}

const failures = [];
async function scenario(name, check) {
  const test = await fixture(`lifecycle-${name}`);
  try {
    await test.initializeDocker();
    await check(test);
    console.log(`PASS: ${name}.`);
  } catch (error) {
    failures.push(error);
    console.error(`FAIL: ${name}: ${error.stack}`);
  } finally {
    try { await test.cleanup(); }
    catch (error) { failures.push(error); }
  }
}

await scenario('crash-recovery', async test => {
  const port = await project(test);
  for (const name of ['recovery-a', 'recovery-b']) {
    test.addName(name);
    await test.cli(['up', '--name', name, '--timeout', '5']);
    await test.cli(['exec', name, '--', 'sh', '-c', `printf '%s' '${name}' > /data/proof`]);
  }
  await test.cli(['use', 'recovery-b']);
  const before = await test.inventory();
  assert.equal(before.filter(record => record.kind === 'container').length, 2);
  const pid = await test.killDaemon();
  let list = await test.cli(['list']);
  assert.notEqual(await test.daemonPid(), pid);
  assert.equal(list.length, 2);
  for (const item of list) {
    assert.equal(item.running, true);
    assert.equal(item.connected, true);
    assert.deepEqual(item.status, { web: 'running' });
    assert.equal(item.services.web.selected, item.name === 'recovery-b');
    await route(port, item.name, item.name);
  }
  const focused = await requestHttp(`http://127.0.0.1:${port}/proof`, { headers: { host: `localhost:${port}` } });
  assert.equal(focused.status, 200);
  assert.equal(focused.body, 'recovery-b');
  assert.deepEqual(await test.inventory(), before, 'Daemon recovery must retain the same resources.');
  const [stopped] = await containers(test, 'recovery-a');
  assert.ok(stopped);
  await docker(['stop', '-t', '1', stopped.id]);
  await test.killDaemon();
  list = await test.cli(['list']);
  const failed = list.find(item => item.name === 'recovery-a');
  assert.equal(failed.status.web, 'exited');
  assert.equal(failed.connected, false);
  assert.match(failed.error, /web exited/);
  await route(port, 'recovery-b', 'recovery-b');
  await test.cli(['up', 'recovery-a']);
  await route(port, 'recovery-a', 'recovery-a');
  assert.equal((await containers(test, 'recovery-a'))[0].id, stopped.id);
  await test.cli(['rm', '--all', '--purge']);
  await test.assertEmpty();
});

await scenario('concurrent-up', async test => {
  const port = await project(test);
  for (const name of ['same', 'different-a', 'different-b']) test.addName(name);
  const same = await Promise.all([test.cli(['up', '--name', 'same']), test.cli(['up', '--name', 'same'])]);
  assert.ok(same.every(item => item.name === 'same' && item.connected));
  let resources = await test.inventory();
  assert.equal(resources.filter(item => item.kind === 'container').length, 1);
  assert.equal(resources.filter(item => item.kind === 'network').length, 1);
  await Promise.all(['different-a', 'different-b'].map(name => test.cli(['up', '--name', name])));
  assert.deepEqual((await test.cli(['list'])).map(item => item.name).sort(), ['different-a', 'different-b', 'same']);
  resources = await test.inventory();
  for (const kind of ['container', 'network', 'volume']) assert.equal(resources.filter(item => item.kind === kind).length, 3, kind);
  for (const name of ['same', 'different-a', 'different-b']) {
    assert.equal((await containers(test, name)).length, 1);
    await test.cli(['exec', name, '--', 'sh', '-c', `printf '%s' '${name}' > /data/proof`]);
    await route(port, name, name);
  }
  await test.cli(['rm', '--all', '--purge']);
  await test.assertEmpty();
});

for (const provider of ['docker', 'compose']) {
  for (const target of ['cli', 'daemon']) {
    await scenario(`interrupt-${provider}-${target}`, async test => {
      const name = 'interrupted';
      test.addName(name);
      const port = await project(test, provider, true);
      const pending = test.start(['up', '--name', name, '--timeout', '30']);
      // The service creates this marker before it waits for the release file.
      await until(() => readGate(test), 60000);
      const resources = await test.inventory();
      assert.equal((await containers(test, name)).length, 1);
      assert.equal(resources.filter(item => item.kind === 'network').length, 1);
      assert.equal(resources.filter(item => item.kind === 'volume').length, 1);
      if (provider === 'compose') assert.equal(resources.filter(item => item.kind === 'image').length, 1);
      const [gated] = await containers(test, name);
      await docker(['exec', gated.id, 'sh', '-c', 'printf before-interruption > /data/proof']);
      const pid = await test.daemonPid();
      if (target === 'cli') {
        assert.ok(pending.child.pid > 1 && pending.child.pid !== pid);
        assert.equal(pending.child.kill('SIGINT'), true);
        assert.equal((await pending.done).signal, 'SIGINT');
        assert.equal(await test.daemonPid(), pid);
      } else {
        await test.killDaemon();
        const result = await pending.done;
        assert.notEqual(result.code, 0, 'The interrupted request must fail when its daemon dies.');
      }
      await writeFile(join(test.cwd, 'release'), 'release');
      let list = await test.cli(['list']);
      if (target === 'cli') {
        // A canceled CLI leaves the daemon operation active. Do not imply server cancellation.
        assert.equal(list.length, 1);
        assert.equal(list[0].name, name);
        assert.equal(list[0].connected, true);
        await test.killDaemon();
        list = await test.cli(['list']);
        assert.equal(list[0].connected, true);
      }
      if (target === 'daemon') {
        assert.equal(list.length, 1);
        assert.equal(list[0].running, false);
        assert.equal(list[0].connected, false);
        assert.equal(list[0].recovery, 'required');
        assert.match(list[0].error, /Startup interrupted/);
        assert.deepEqual(await test.inventory(), resources, 'Restart must not start or delete interrupted resources.');
      }
      await test.settleAllocation();
      const resumed = await test.invoke(['--json', 'up', '--name', name, '--timeout', '5'], false);
      if (resumed.code === 0) await route(port, name, 'before-interruption');
      const purged = await test.invoke(['--json', 'rm', name, '--purge'], false);
      // Check leaks even when recovery fails, so both defects appear in the report.
      const remaining = await test.inventory();
      assert.equal(resumed.code, 0, `Recovery failed: ${resumed.stderr.trim()}. Purge: ${purged.stderr.trim()}. Remaining: ${JSON.stringify(remaining)}`);
      assert.equal(purged.code, 0, `Public purge failed: ${purged.stderr}`);
      assert.deepEqual(remaining, [], 'Public purge left resources from interrupted startup.');
      await test.assertEmpty();
      // Recovery must also permit a new instance with the same name.
      await test.cli(['up', '--name', name, '--timeout', '5']);
      await test.cli(['exec', name, '--', 'sh', '-c', 'printf recovered > /data/proof']);
      await route(port, name, 'recovered');
      await test.cli(['rm', name, '--purge']);
      await test.assertEmpty();
    });
  }
}

for (const provider of ['docker', 'compose']) {
  await scenario(`direct-purge-${provider}`, async test => {
    const name = 'interrupted';
    test.addName(name);
    await project(test, provider, true);
    const pending = test.start(['up', '--name', name, '--timeout', '30']);
    await until(() => readGate(test), 60000);
    await test.killDaemon();
    assert.notEqual((await pending.done).code, 0);
    const [item] = await test.cli(['list']);
    assert.equal(item.recovery, 'required');
    assert.equal(item.connected, false);
    assert.ok(item.error.includes(`agent-env up ${name}`));
    for (const args of [['snapshot', name, join(test.directory, 'partial-snapshot')], ['fork', name, 'partial-fork']]) {
      const rejected = await test.invoke(args, false);
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, /Recover interrupted startup/);
    }
    // The detached worker can still be active after the daemon exits.
    await test.settleAllocation();
    await test.cli(['rm', name, '--purge']);
    await test.assertEmpty();
  });

  await scenario(`partial-${provider}`, async test => {
    const name = 'partial';
    test.addName(name);
    const port = await project(test, provider, true);
    const configPath = join(test.cwd, provider === 'docker' ? 'agent-env.json' : 'compose.yaml');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    for (let index = 0; index < 12; index++) {
      config.services[`extra${index}`] = provider === 'docker'
        ? { ...config.services.web, port: await freePort() }
        : { ...config.services.web, depends_on: ['web'], ports: [`${await freePort()}:8080`] };
    }
    await writeFile(configPath, JSON.stringify(config));
    const pid = await test.daemonPid();
    const { owner } = JSON.parse(await readFile(join(test.home, 'state.json'), 'utf8'));
    // Interrupt the daemon during allocation. Compose's worker can finish its batch.
    // Read past events too, so subscription startup cannot miss this event.
    const events = spawn('docker', ['events', '--since', String(Math.floor(Date.now() / 1000) - 1), '--filter', 'type=container', '--filter', 'event=create', '--filter', `label=agent-env.instance=${name}`, '--filter', `label=agent-env.owner=${owner}`, '--format', '{{json .}}']);
    let observed = false;
    let output = '';
    events.stdout.on('data', chunk => {
      output += chunk;
      if (!observed && output.includes('\n')) { observed = true; process.kill(pid, 'SIGKILL'); }
    });
    const pending = test.start(['up', '--name', name, '--timeout', '30']);
    try {
      assert.notEqual((await pending.done).code, 0);
      assert.equal(observed, true);
    } finally { events.kill('SIGTERM'); }
    const resources = await test.inventory();
    const created = resources.filter(item => item.kind === 'container').length;
    assert.ok(created > 0 && created <= 13, 'The interrupted startup must leave owned containers.');
    if (provider === 'docker') assert.ok(created < 13, 'Interrupt before every configured service exists.');
    const [item] = await test.cli(['list']);
    assert.equal(item.recovery, 'required');
    assert.equal(item.running, false);
    await writeFile(join(test.cwd, 'release'), 'release');
    await test.settleAllocation();
    if (provider === 'compose') {
      const completed = (await test.inventory()).filter(item => item.kind === 'container');
      assert.equal(completed.length, 13, 'The detached Compose worker must complete its allocation batch.');
      // Create a deterministic partial set after the worker settles.
      // This models an externally removed container without racing Compose creation.
      await docker(['rm', '-fv', completed.find(item => item.name.endsWith('-extra0-1')).id]);
      assert.equal((await test.inventory()).filter(item => item.kind === 'container').length, 12);
    }
    await test.cli(['up', name, '--timeout', '30']);
    assert.equal((await test.inventory()).filter(item => item.kind === 'container').length, 13);
    await test.cli(['exec', name, '--service', 'web', '--', 'sh', '-c', 'printf partial-recovered > /data/proof']);
    await route(port, name, 'partial-recovered');
    await test.cli(['rm', name, '--purge']);
    await test.assertEmpty();
  });

  await scenario(`retry-failure-${provider}`, async test => {
    const name = 'retry';
    test.addName(name);
    const port = await project(test, provider, true);
    const pending = test.start(['up', '--name', name, '--timeout', '30']);
    await until(() => readGate(test), 60000);
    const [owned] = await containers(test, name);
    await docker(['exec', owned.id, 'sh', '-c', 'printf retained-after-failure > /data/proof']);
    const [volume] = (await test.inventory()).filter(item => item.kind === 'volume');
    await test.killDaemon();
    assert.notEqual((await pending.done).code, 0);
    await test.settleAllocation();
    const failed = await test.invoke(['up', name, '--timeout', '1'], false);
    assert.notEqual(failed.code, 0, 'The closed gate must make recovery fail.');
    assert.equal((await test.cli(['list']))[0].recovery, 'required');
    assert.equal(await docker(['run', '--rm', '--mount', `type=volume,src=${volume.name},dst=/data,readonly`, 'busybox:1.37', 'cat', '/data/proof']), 'retained-after-failure');
    await writeFile(join(test.cwd, 'release'), 'release');
    await test.cli(['up', name, '--timeout', '10']);
    await route(port, name, 'retained-after-failure');
    await test.cli(['rm', name, '--purge']);
    await test.assertEmpty();
  });

  for (const interrupted of [true, false]) {
    await scenario(`foreign-${provider}-${interrupted ? 'startup' : 'running'}`, async test => {
      const name = 'foreign';
      test.addName(name);
      await project(test, provider, interrupted);
      let pending;
      if (interrupted) {
        pending = test.start(['up', '--name', name, '--timeout', '30']);
        await until(() => readGate(test), 60000);
      } else await test.cli(['up', '--name', name]);
      const [owned] = await containers(test, name);
      await test.killDaemon();
      if (pending) assert.notEqual((await pending.done).code, 0);
      await test.settleAllocation();
      await docker(['rm', '-f', owned.id]);
      const foreign = await docker(['run', '-d', '--name', owned.name, '--label', `agent-env.owner=${owned.labels['agent-env.owner']}`, '--label', `agent-env.instance=${name}`, '--label', 'agent-env.record=foreign', 'busybox:1.37', 'sleep', '3600']);
      try {
        await writeFile(join(test.cwd, 'release'), 'release');
        const before = await test.inventory();
        const [item] = await test.cli(['list']);
        assert.equal(item.connected, false);
        assert.match(item.error, interrupted ? /Startup interrupted/ : /Refusing foreign container/);
        for (const args of [['up', name], ['rm', name, '--purge']]) {
          const result = await test.invoke(args, false);
          assert.notEqual(result.code, 0);
          assert.match(result.stderr, /Refusing foreign container/);
          const [info] = JSON.parse(await docker(['inspect', foreign]));
          assert.equal(info.Id, foreign);
          assert.equal(info.State.Status, 'running', 'Do not stop a foreign container.');
          assert.equal((await test.cli(['list']))[0].recovery, interrupted ? 'required' : undefined);
          assert.deepEqual(await test.inventory(), before, 'Refusal must preserve every resource.');
        }
      } finally { await docker(['rm', '-f', foreign]); }
      await test.cli(['rm', name, '--purge']);
      await test.assertEmpty();
    });
  }
}

async function readGate(test) {
  return readFile(join(test.cwd, 'entered')).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

if (failures.length) throw new AggregateError(failures, `${failures.length} lifecycle E2E checks failed.`);
