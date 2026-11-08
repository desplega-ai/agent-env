import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sourceExclusions, shouldSync } from '../src/source-paths.mjs';
import { run } from '../src/system.mjs';

test('rsync and watcher exclusions agree while nested build and dist sources remain available', async t => {
  const directory = await mkdtemp('/tmp/agent-env-source-paths-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'), destination = join(directory, 'destination');
  await mkdir(destination);
  const paths = ['dist/output.js', 'build/Dockerfile', '.cache/item', 'coverage/report', '.next/output', '.git/config',
    'apps/web/node_modules/dep.js', 'apps/web/.env.local', '.agent-env/state', 'src/build/Dockerfile', 'src/dist/source.js', 'src/.cache/source.js', 'index.js'];
  for (const path of paths) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), path); }
  await run('rsync', ['-a', ...sourceExclusions.map(rule => `--exclude=${rule}`), `${source}/`, `${destination}/`]);
  for (const path of paths) assert.equal(await stat(join(destination, path)).then(() => true, () => false), shouldSync(path), path);
  for (const path of ['src/build/Dockerfile', 'src/dist/source.js', 'src/.cache/source.js']) assert.equal(shouldSync(path), true);
});
