import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, freePort, subprocess } from './helpers.mjs';

if (!process.env.AGENT_ENV_CLI) throw new Error('Set AGENT_ENV_CLI to the absolute path of the audited, installed CLI.');
const quiet = { ...process.env, HCLOUD_DEBUG: 'false', HCLOUD_DEBUG_FILE: '' };
const secret = 'agent-env-preflight-private-marker';
const invalidToken = 'agent-env-preflight-invalid-token';
const hcloud = args => subprocess('hcloud', args, { env: quiet, timeout: 30000 });
const privateValues = [secret, invalidToken];
function privateOutput(text) {
  for (const value of privateValues) assert.ok(!text.includes(value), 'Public diagnostics contain a private value.');
  assert.doesNotMatch(text, /BEGIN (?:OPENSSH |RSA )?PRIVATE KEY|ssh-ed25519|cloud-config|Authorization:|user-data-from-file|--allow-sensitive/);
}
async function rejected(type, location, expected, env = {}, inspect = () => {}) {
  // Keep the Unix socket path below the macOS length limit.
  const f = await fixture('cp', env);
  try {
    const port = await freePort();
    await writeFile(join(f.cwd, 'agent-env.json'), JSON.stringify({ services: { web: {
      image: 'busybox:1.37', port, containerPort: 3000, env: { PRIVATE_TOKEN: secret },
    } } }));
    const result = await f.invoke(['up', '--name', 'preflight', '--cloud', 'hetzner', '--cloud-type', type,
      '--location', location, '--no-env-file', '--idle-minutes', '5', '--ttl-hours', '0.5'], false);
    assert.notEqual(result.code, 0, 'The selection must fail before allocation.');
    privateOutput(result.stdout + result.stderr);
    assert.match(result.stderr, expected);
    await inspect(result.stderr);
    const entries = await readdir(join(f.home, 'cloud'), { recursive: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(entries, [], 'Preflight must not create records, keys, or user data.');
    const state = JSON.parse(await readFile(join(f.home, 'state.json'), 'utf8'));
    assert.deepEqual(state.instances, {}, 'Failed preflight must not retain an instance.');
    const log = await readFile(join(f.home, 'daemon.log'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    privateOutput(log);
    return state.owner;
  } finally { await f.cleanup(); }
}

// Use the real CLI and API. An invalid token cannot allocate any resource.
const authDirectory = await mkdtemp(join(tmpdir(), 'agent-env-ca-'));
try {
  const config = join(authDirectory, 'hcloud.toml');
  await writeFile(config, '', { mode: 0o600 });
  const env = { HCLOUD_CONFIG: config, HCLOUD_CONTEXT: '', HCLOUD_TOKEN: '', HCLOUD_ENDPOINT: 'https://api.hetzner.cloud/v1' };
  await rejected('cx23', 'fsn1', /authenticated.*context|authenticated context/, env);
  const badEnv = { ...quiet, ...env, HCLOUD_TOKEN: invalidToken };
  const genuine = await subprocess('hcloud', ['server-type', 'list', '--output', 'json'], { env: badEnv, timeout: 30000 });
  assert.notEqual(genuine.code, 0);
  if (/\(unauthorized\)/.test(genuine.stderr)) {
    await rejected('cx23', 'fsn1', /\(unauthorized\).*token is invalid/, { ...env, HCLOUD_TOKEN: invalidToken, HCLOUD_DEBUG: 'true' });
    console.log('PASS: genuine hcloud unauthorized diagnostics remain actionable and private.');
  } else {
    privateOutput(genuine.stderr);
    console.log('SKIP: the API did not return unauthorized. Live provider diagnostic coverage requires connectivity.');
  }
} finally { await rm(authDirectory, { recursive: true, force: true }); }

// Live availability can change between this suite's read and the CLI's allocation check.
if (process.env.AGENT_ENV_TEST_CLOUD !== '1') {
  console.log('SKIP: authenticated selection tests require AGENT_ENV_TEST_CLOUD=1. These tests can create billed resources.');
  process.exit(0);
}
const credentials = await hcloud(['config', 'get', 'token', '--allow-sensitive']);
if (credentials.code === 0 && credentials.stdout.trim()) privateValues.push(credentials.stdout.trim());
const ambientTypes = await hcloud(['server-type', 'list', '--output', 'json']);
if (ambientTypes.code !== 0) {
  privateOutput(ambientTypes.stderr);
  console.log('SKIP: current hcloud authentication or connectivity is unavailable. Live selection coverage did not run.');
} else {
  const types = JSON.parse(ambientTypes.stdout);
  const locationResult = await hcloud(['location', 'list', '--output', 'json']);
  assert.equal(locationResult.code, 0, 'Read-only location listing failed.');
  const locations = JSON.parse(locationResult.stdout);
  assert.ok(types.length && locations.length);
  const pricingResult = await hcloud(['api', '/pricing']);
  assert.equal(pricingResult.code, 0, 'Read-only pricing failed.');
  const { pricing } = JSON.parse(pricingResult.stdout);
  assert.match(pricing.currency, /^[A-Z]{3}$/);
  const location = locations.find(item => item.name === 'fsn1') ?? locations[0];
  const owners = [];
  async function priced(text, selectedLocation = location) {
    assert.ok(text.includes(`Selected Hetzner type`));
    assert.ok(text.includes(`Live alternatives at ${selectedLocation.name}`));
    assert.ok(text.includes(`Prices use ${pricing.currency}, net (exclude VAT)`));
    assert.ok(text.includes(`Project VAT rate: ${Number(pricing.vat_rate)}%`));
    const rows = [...text.matchAll(/([a-z0-9]+) \((x86|arm)\): ([0-9.]+)\/hour, ([0-9.]+)\/month/g)];
    assert.ok(rows.length <= 5, 'Alternatives must remain bounded.');
    const available = types.filter(item => item.locations?.some(entry => entry.name === selectedLocation.name && entry.available));
    if (available.length) assert.ok(rows.length > 0, 'Available alternatives need live prices.');
    for (const [, name, architecture, hourly, monthly] of rows) {
      const type = types.find(item => item.name === name);
      assert.equal(type.architecture, architecture);
      assert.ok(type.locations.some(entry => entry.name === selectedLocation.name && entry.available));
      const price = pricing.server_types.find(item => item.id === type.id).prices.find(item => item.location === selectedLocation.name);
      assert.equal(Number(hourly), Number(price.price_hourly.net));
      assert.equal(Number(monthly), Number(price.price_monthly.net));
    }
    const ipv4 = pricing.primary_ips.find(item => item.type === 'ipv4')?.prices.find(item => item.location === selectedLocation.name);
    assert.ok(text.includes('Server prices exclude IPv4.'));
    if (ipv4) assert.ok(text.includes(`IPv4 separately: ${Number(ipv4.price_hourly.net)}/hour, ${Number(ipv4.price_monthly.net)}/month`));
  }
  owners.push(await rejected('agent-env-unknown-type', location.name, /Unknown server type/, {}, priced));
  owners.push(await rejected('2147483647', String(location.id), /Unknown server type/, {}, priced));
  owners.push(await rejected(types[0].name, 'agent-env-unknown-location', /Unknown location.*hcloud location list/));
  owners.push(await rejected(String(types[0].id), '2147483647', /Unknown location/));
  const unavailableTypes = types.filter(item => item.locations?.some(entry => entry.name === location.name && entry.available === false));
  const unavailable = unavailableTypes.find(item => item.deprecation) ?? unavailableTypes[0];
  if (unavailable) {
    owners.push(await rejected(unavailable.name, location.name, /unavailable for new allocation/, {}, priced));
    owners.push(await rejected(String(unavailable.id), String(location.id), /unavailable for new allocation/, {}, priced));
    console.log('PASS: unavailable types fail before allocation with names and numeric IDs.');
  } else console.log('SKIP: the API reports no unavailable type at this location.');
  const unsupportedLocation = locations.find(place => types.some(item => Array.isArray(item.locations) && !item.locations.some(entry => entry.name === place.name)));
  const unsupported = types.find(item => Array.isArray(item.locations) && !item.locations.some(entry => entry.name === unsupportedLocation?.name));
  if (unsupportedLocation && unsupported) {
    owners.push(await rejected(unsupported.name, unsupportedLocation.name, /does not support this location/, {}, text => priced(text, unsupportedLocation)));
    console.log('PASS: an unsupported type and location fail before allocation.');
  } else console.log('SKIP: the API reports no unsupported type and location combination.');
  for (const kind of ['server', 'primary-ip', 'ssh-key']) {
    const resources = await hcloud([kind, 'list', '--output', 'json']);
    assert.equal(resources.code, 0, `Read-only ${kind} verification failed.`);
    assert.ok(JSON.parse(resources.stdout).every(item => !owners.includes(item.labels?.['agent-env.owner'])), `${kind} exists for a rejected preflight.`);
  }
  console.log('PASS: live unknown names, numeric IDs, prices, privacy, and independent resource cleanup checks.');
}
