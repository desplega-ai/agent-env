import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { compareVersions, parseVersion } from './release-version.mjs';

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();
assert.equal(process.env.GITHUB_REPOSITORY, 'desplega-ai/agent-env');
assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
assert.ok(['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME));
assert.equal(run('git', ['rev-parse', 'HEAD']), process.env.GITHUB_SHA, 'Release must use the tested commit.');
const { name, version } = JSON.parse(readFileSync('package.json'));
assert.equal(name, '@desplega.ai/agent-env');
const parsed = parseVersion(version);
const tarball = resolve(process.argv[2]);
const packed = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']));
assert.equal(packed.name, name);
assert.equal(packed.version, version, 'The tarball version must match package.json exactly.');
assert.equal(version, process.env.RELEASE_VERSION, 'The detected release version changed.');
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const expectedIntegrity = integrity(readFileSync(tarball));
const tag = `v${version}`, repo = process.env.GITHUB_REPOSITORY;
const registry = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
const response = await fetch(registry, { signal: AbortSignal.timeout(30000) });
assert.ok(response.ok || response.status === 404, `The npm registry returned ${response.status}.`);
const metadata = response.status === 404 ? { versions: {} } : await response.json();
const published = metadata.versions?.[version];
if (published) {
  assert.equal(published.version, version);
  assert.equal(published.dist?.integrity, expectedIntegrity, 'This npm version contains a different tarball.');
} else {
  for (const previous of Object.keys(metadata.versions ?? {})) {
    assert.ok(compareVersions(version, previous) > 0, `The release version must exceed published version ${previous}.`);
  }
}
// A retry must never move an existing tag or replace an existing asset.
const remoteTag = run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
if (remoteTag) {
  const lines = remoteTag.split('\n');
  const commit = (lines.find(line => line.endsWith('^{}')) ?? lines[0]).split(/\s/)[0];
  assert.equal(commit, process.env.GITHUB_SHA, 'The release tag refers to another commit.');
}
const releases = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat();
const release = releases.find(item => item.tag_name === tag);
if (release) assert.ok(remoteTag, 'An existing release requires its verified Git tag.');
const asset = release?.assets.find(item => item.name === basename(tarball));
if (release) assert.ok(release.assets.every(item => item.name === basename(tarball)), 'The release contains unexpected assets.');
const temporary = mkdtempSync(join(tmpdir(), 'agent-env-release-'));
try {
  if (asset) {
    run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', basename(tarball), '--dir', temporary]);
    assert.equal(integrity(readFileSync(join(temporary, basename(tarball)))), expectedIntegrity, 'The release asset contains a different tarball.');
  }
  if (!published) {
    const npmVersion = run('npm', ['--version']);
    assert.ok(compareVersions(npmVersion, '11.5.1') >= 0, 'npm 11.5.1 or later is required for OIDC.');
    const env = { ...process.env };
    // OIDC is the default. Bootstrap can explicitly select the existing token.
    env.NPM_CONFIG_USERCONFIG = join(temporary, 'npmrc');
    writeFileSync(env.NPM_CONFIG_USERCONFIG, '', { mode: 0o600 });
    if (env.USE_NPM_TOKEN === 'true') {
      assert.ok(env.NODE_AUTH_TOKEN, 'Token publishing requires the NPM_TOKEN secret.');
      writeFileSync(env.NPM_CONFIG_USERCONFIG, '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n', { mode: 0o600 });
    } else delete env.NODE_AUTH_TOKEN;
    run('npm', ['publish', tarball, '--registry=https://registry.npmjs.org', '--access=public', '--provenance', '--ignore-scripts', '--tag', parsed.pre ? 'next' : 'latest'], { env, stdio: 'inherit' });
  }
  const checked = await fetch(`${registry}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(30000) });
  assert.ok(checked.ok, `The npm version check returned ${checked.status}. Retry the workflow after registry propagation.`);
  const confirmed = await checked.json();
  assert.equal(confirmed.version, version);
  assert.equal(confirmed.dist?.integrity, expectedIntegrity);
  if (!remoteTag) {
    run('git', ['tag', tag, process.env.GITHUB_SHA]);
    run('git', ['push', 'origin', `refs/tags/${tag}`]);
  }
  if (!release) {
    run('gh', ['release', 'create', tag, tarball, '--repo', repo, '--verify-tag', '--title', tag, '--generate-notes', ...(parsed.pre ? ['--prerelease'] : [])]);
  } else {
    if (!asset) run('gh', ['release', 'upload', tag, tarball, '--repo', repo]);
    if (release.draft) run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false']);
  }
  console.log(`Released ${name}@${version} from ${process.env.GITHUB_SHA}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
