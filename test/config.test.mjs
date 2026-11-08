import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/config.mjs';
import { quote, run } from '../src/system.mjs';

const spec = () => ({ name: 'demo', provider: 'docker', services: { web: { image: 'busybox:1.37', port: 3000 } } });
test('configuration rejects ambiguous ports and unsafe names before provisioning', () => {
  assert.throws(() => validate({ ...spec(), name: '-option' }), /name/);
  assert.throws(() => validate({ ...spec(), host: 'host; touch /tmp/unwanted' }), /SSH alias/);
  const duplicate = spec();
  duplicate.services.api = { image: 'busybox:1.37', port: 3000 };
  assert.throws(() => validate(duplicate), /more than once/);
  const volume = spec();
  volume.services.web.volumes = { data: '/path,readonly' };
  assert.throws(() => validate(volume), /Volume destinations/);
  const port = spec();
  port.services.web.containerPort = 80;
  assert.equal(validate(port).services.web.containerPort, 80);
});

test('SSH command quoting retains arguments literally', async () => {
  const value = "space ' quote $(printf unsafe) `printf unsafe`\nline";
  assert.equal(await run('sh', ['-c', `printf '%s' ${quote(value)}`]), value);
});
