import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export function parseVersion(version) {
  assert.equal(typeof version, 'string', 'The package version must be a string.');
  const match = semver.exec(version);
  assert.ok(match, `Invalid SemVer: ${version}`);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') };
}
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  const compare = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  for (let index = 0; index < 3; index++) {
    const result = compare(a.core[index], b.core[index]);
    if (result) return result;
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (a.pre[index] === undefined) return -1;
    if (b.pre[index] === undefined) return 1;
    const x = a.pre[index], y = b.pre[index];
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y);
    const result = numericX && numericY ? compare(BigInt(x), BigInt(y)) : numericX !== numericY ? numericX ? -1 : 1 : compare(x, y);
    if (result) return result;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { name, version } = JSON.parse(readFileSync('package.json'));
  assert.equal(name, '@desplega.ai/agent-env');
  parseVersion(version);
  assert.ok(!version.includes('+'), 'npm releases cannot preserve SemVer build metadata.');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let changed = false;
  const pullRequest = process.env.GITHUB_EVENT_NAME === 'pull_request';
  if (pullRequest || process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/master') {
    const before = pullRequest ? event.pull_request?.base?.sha : event.before;
    assert.match(before, /^[a-f0-9]{40}$/);
    if (!/^0+$/.test(before)) {
      const old = JSON.parse(execFileSync('git', ['show', `${before}:package.json`], { encoding: 'utf8' })).version;
      if (old !== version) {
        assert.ok(compareVersions(version, old) > 0, `The version must increase: ${old} -> ${version}`);
        changed = !pullRequest;
      }
    }
  }
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && event.inputs?.release === 'true') changed = true;
  if (changed) assert.equal(process.env.GITHUB_REF, 'refs/heads/master', 'Release only from master.');
  console.log(`Version ${version}. Release requested: ${changed}.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nrelease=${changed}\n`);
}
