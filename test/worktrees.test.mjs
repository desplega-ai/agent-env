import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/system.mjs';
import { createWorktree, removeOwnedWorktree } from '../src/worktrees.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dev-now-worktrees-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'source');
  await mkdir(cwd);
  const git = (...args) => run('git', ['-C', cwd, ...args]);
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'Test');
  await writeFile(join(cwd, 'app.txt'), 'original\n');
  await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 255, 13, 10, 129]));
  await writeFile(join(cwd, 'remove.txt'), 'remove later');
  await writeFile(join(cwd, '.gitignore'), 'node_modules/\nignored.txt\n');
  await git('add', '.');
  await git('commit', '-m', 'Initial');
  return { directory, cwd, git };
}

test('fork copies tracked edits, additions, deletions, and safe untracked bytes without source mutation', async t => {
  const { cwd, directory, git } = await fixture(t);
  await writeFile(join(cwd, 'app.txt'), 'staged\n');
  await git('add', 'app.txt');
  await writeFile(join(cwd, 'app.txt'), 'working\n');
  await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 254, 0, 253]));
  await rm(join(cwd, 'remove.txt'));
  await writeFile(join(cwd, 'added.txt'), 'staged addition');
  await git('add', 'added.txt');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src', 'new.txt'), 'untracked\n');
  await mkdir(join(cwd, 'src/build'));
  await writeFile(join(cwd, 'src/build/source.txt'), 'nested source');
  await chmod(join(cwd, 'src', 'new.txt'), 0o755);
  for (const name of ['.env', '.env.production', 'secret.key', '.npmrc', 'ignored.txt']) await writeFile(join(cwd, name), 'sensitive');
  await mkdir(join(cwd, 'node_modules'));
  await writeFile(join(cwd, 'node_modules', 'dep.js'), 'build');
  await symlink('/etc/passwd', join(cwd, 'outside-link'));
  const before = await git('status', '--porcelain=v1');
  const result = await createWorktree({ cwd }, 'feature', { path: join(directory, 'fork') });
  assert.equal(await readFile(join(result.cwd, 'app.txt'), 'utf8'), 'working\n');
  assert.deepEqual(await readFile(join(result.cwd, 'binary.dat')), Buffer.from([0, 254, 0, 253]));
  assert.equal(await readFile(join(result.cwd, 'added.txt'), 'utf8'), 'staged addition');
  await assert.rejects(lstat(join(result.cwd, 'remove.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(result.cwd, 'src', 'new.txt'), 'utf8'), 'untracked\n');
  assert.equal(await readFile(join(result.cwd, 'src/build/source.txt'), 'utf8'), 'nested source');
  assert.ok((await lstat(join(result.cwd, 'src', 'new.txt'))).mode & 0o111);
  for (const name of ['.env', '.env.production', 'secret.key', '.npmrc', 'ignored.txt', 'node_modules', 'outside-link']) await assert.rejects(lstat(join(result.cwd, name)), { code: 'ENOENT' });
  assert.ok(result.omittedPaths.includes('.env'));
  assert.equal(await git('status', '--porcelain=v1'), before);
  await writeFile(join(result.cwd, 'app.txt'), 'fork only');
  assert.equal(await readFile(join(cwd, 'app.txt'), 'utf8'), 'working\n');
  await assert.rejects(removeOwnedWorktree(result), /dirty/);
  await removeOwnedWorktree(result, { dirty: 'discard' });
  assert.equal(await git('branch', '--list', 'feature'), '');
});

test('fork supports a specific ref, branch, path, and a clean checkout option', async t => {
  const { cwd, directory, git } = await fixture(t);
  await git('tag', 'base');
  await writeFile(join(cwd, 'app.txt'), 'later');
  await git('commit', '-am', 'Later');
  await writeFile(join(cwd, 'app.txt'), 'uncommitted');
  const result = await createWorktree(cwd, 'alias', { branch: 'feature/nested', ref: 'base', path: join(directory, 'space path'), copyChanges: false });
  assert.equal(await readFile(join(result.cwd, 'app.txt'), 'utf8'), 'original\n');
  assert.equal(await run('git', ['-C', result.cwd, 'branch', '--show-current']), 'feature/nested');
  assert.equal((await removeOwnedWorktree(result)).branchRetained, false);
});

test('fork refuses existing branches, paths, unsafe names, and nested destinations', async t => {
  const { cwd, directory, git } = await fixture(t);
  await git('branch', 'existing');
  await assert.rejects(createWorktree(cwd, 'existing'), /already exists/);
  const existing = join(directory, 'occupied');
  await mkdir(existing);
  await writeFile(join(existing, 'keep'), 'keep');
  await assert.rejects(createWorktree(cwd, 'new', { path: existing }), /already exists/);
  await assert.rejects(createWorktree(cwd, '../escape'), /name/);
  await assert.rejects(createWorktree(cwd, 'nested', { path: join(cwd, 'nested') }), /outside/);
  await assert.rejects(createWorktree(cwd, 'bad-ref', { ref: '--all' }), /Git/);
  assert.equal(await readFile(join(existing, 'keep'), 'utf8'), 'keep');
});

test('failed patch application removes only the new worktree and branch', async t => {
  const { cwd, directory, git } = await fixture(t);
  await git('tag', 'old');
  await writeFile(join(cwd, 'app.txt'), 'different baseline\n');
  await git('commit', '-am', 'New baseline');
  await writeFile(join(cwd, 'app.txt'), 'current dirty\n');
  const path = join(directory, 'failed');
  await assert.rejects(createWorktree(cwd, 'failed', { path, ref: 'old' }), /apply/);
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.equal(await git('branch', '--list', 'failed'), '');
  assert.equal(await readFile(join(cwd, 'app.txt'), 'utf8'), 'current dirty\n');
});

test('untracked collisions fail without replacing the selected ref or source files', async t => {
  const { cwd, directory, git } = await fixture(t);
  await writeFile(join(cwd, 'collision'), 'committed');
  await git('add', 'collision');
  await git('commit', '-m', 'Collision target');
  await git('tag', 'with-collision');
  await git('rm', 'collision');
  await git('commit', '-m', 'Remove collision');
  await writeFile(join(cwd, 'collision'), 'source untracked');
  const path = join(directory, 'failed');
  await assert.rejects(createWorktree(cwd, 'failed', { path, ref: 'with-collision' }), /EEXIST/);
  assert.equal(await readFile(join(cwd, 'collision'), 'utf8'), 'source untracked');
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.equal(await git('branch', '--list', 'failed'), '');
});

test('removal validates ownership and preserves a branch with new commits', async t => {
  const { cwd, directory, git } = await fixture(t);
  const result = await createWorktree(cwd, 'committed', { path: join(directory, 'committed') });
  await assert.rejects(removeOwnedWorktree({ ...result.ownership, path: cwd }), /does not match/);
  await writeFile(join(result.cwd, 'app.txt'), 'new commit');
  await run('git', ['-C', result.cwd, 'commit', '-am', 'Preserve this commit']);
  assert.equal((await removeOwnedWorktree(result)).branchRetained, true);
  assert.notEqual(await git('branch', '--list', 'committed'), '');
  assert.equal(await readFile(join(cwd, 'app.txt'), 'utf8'), 'original\n');
});

test('removal refuses ignored data, and fork refuses committed credentials', async t => {
  const { cwd, directory, git } = await fixture(t);
  const result = await createWorktree(cwd, 'ignored', { path: join(directory, 'ignored') });
  await writeFile(join(result.cwd, 'ignored.txt'), 'must preserve');
  await assert.rejects(removeOwnedWorktree(result), /dirty/);
  await removeOwnedWorktree(result, { dirty: 'discard' });
  await writeFile(join(cwd, '.env'), 'committed secret');
  await git('add', '.env');
  await git('commit', '-m', 'Credential test');
  await assert.rejects(createWorktree(cwd, 'credentials'), /tracks credential/);
});

test('fork preserves a source subdirectory and rejects a ref without that directory', async t => {
  const { cwd, directory, git } = await fixture(t);
  await git('tag', 'root-only');
  await mkdir(join(cwd, 'app'));
  await writeFile(join(cwd, 'app', 'index.js'), 'export default 1;');
  await git('add', 'app');
  await git('commit', '-m', 'Application directory');
  const result = await createWorktree(join(cwd, 'app'), 'subdir', { path: join(directory, 'subdir') });
  assert.equal(result.cwd, join(result.ownership.path, 'app'));
  await removeOwnedWorktree(result);
  const failed = join(directory, 'missing');
  await assert.rejects(createWorktree(join(cwd, 'app'), 'missing', { path: failed, ref: 'root-only', copyChanges: false }), /ENOENT|working directory/);
  await assert.rejects(lstat(failed), { code: 'ENOENT' });
  assert.equal(await git('branch', '--list', 'missing'), '');
});
