import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const destination = resolve(process.argv[2] ?? '.');
mkdirSync(destination, { recursive: true });
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { encoding: 'utf8' }));
assert.equal(packed.name, '@desplega.ai/agent-env');
const tarball = resolve(destination, packed.filename);
const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').sort();
assert.deepEqual(files, packed.files.map(file => `package/${file.path}`).sort(), 'The archive and npm file lists differ.');
for (const file of files) {
  assert.match(file, /^package\/(?:package\.json|README\.md|LICENSE|(?:bin|src|docs|examples|assets|skills)\/.+)$/);
  assert.ok(!file.split('/').some(part => part === '..' || part === '.git' || part === 'node_modules' || /^\.env(?:\.|$)/.test(part) && !part.endsWith('.example')), `Unsafe package file: ${file}`);
  assert.ok(!/\.(?:pem|key|tgz|log)$/.test(file), `Unsafe package file: ${file}`);
  assert.ok(!file.split('/').some(part => /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.envrc|\.npmrc|credentials)$/.test(part)), `Credential file: ${file}`);
  assert.ok(!file.endsWith('/VERIFICATION.md') && !file.startsWith('package/assets/concepts/'), `Unpublished development file: ${file}`);
}
for (const file of ['package/package.json', 'package/bin/agent-env.mjs', 'package/src/daemon.mjs', 'package/src/sdk.mjs', 'package/src/sdk.d.ts', 'package/README.md', 'package/LICENSE', 'package/skills/agent-env/SKILL.md', 'package/skills/agent-env/references/remote-and-data.md']) {
  assert.ok(files.includes(file), `The package lacks ${file}.`);
}
const metadata = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
assert.equal(metadata.version, JSON.parse(readFileSync('package.json')).version);
assert.equal(packed.version, metadata.version, 'npm must preserve the exact package version.');
assert.deepEqual(metadata.bin, { 'agent-env': './bin/agent-env.mjs' });
assert.deepEqual(metadata.exports, { '.': { types: './src/sdk.d.ts', import: './src/sdk.mjs', default: './src/sdk.mjs' } });
console.log(files.join('\n'));
console.log(`Audited ${files.length} files: ${packed.filename} (${packed.integrity})`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${packed.filename}\nversion=${packed.version}\n`);
