import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, realpath, lstat, open, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

async function git(cwd, args, input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const output = [], errors = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolveResult(Buffer.concat(output))
      : reject(new Error(`Git ${args[0]} failed: ${Buffer.concat(errors).toString().trim()}`)));
    child.stdin.end(input);
  });
}

const text = async (cwd, args) => (await git(cwd, args)).toString().trim();
const names = buffer => buffer.toString().split('\0').filter(Boolean);
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)); };

function credential(path) {
  return path.split('/').some(part =>
    /^\.env(?:\..*)?$/.test(part) && !/\.(?:example|sample|template)$/.test(part)
    || /^(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.envrc|(?:application_default_)?credentials(?:\.json)?|service[-_]account(?:[-_].*)?\.json|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(part)
    || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part));
}

function excluded(path) {
  return credential(path) || path.split('/').some(part => /^(?:\.git|\.dev-now|node_modules|vendor|dist|build|target|coverage|\.next|\.nuxt|\.cache|\.turbo|\.venv|venv|__pycache__)$/i.test(part));
}

async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Destination ${path} already exists. Choose a new path.`);
}

async function copySourceFile(sourceRoot, destination, path) {
  const source = join(sourceRoot, path), target = join(destination, path);
  if (!inside(sourceRoot, source) || !inside(destination, target)) throw new Error('The source path leaves the repository.');
  const info = await lstat(source);
  if (!info.isFile()) return false;
  if (!inside(sourceRoot, await realpath(source))) throw new Error('The source file resolves outside the repository.');
  // Check each destination ancestor before copying through it.
  let current = destination;
  for (const part of relative(destination, dirname(target)).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await lstat(current)).isDirectory()) throw new Error(`Destination ancestor ${current} is not a directory.`);
  }
  // Exclusive creation prevents a source file from replacing a file in the selected ref.
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await sourceHandle.stat()).isFile()) throw new Error('Only regular untracked files can be copied.');
    await pipeline(sourceHandle.createReadStream(), createWriteStream(target, { flags: 'wx', mode: info.mode & 0o777 }));
  } finally { await sourceHandle.close(); }
  return true;
}

async function recordPath(ownership) {
  if (ownership?.version !== 1 || !/^[0-9a-f-]{36}$/.test(ownership.token ?? '')) throw new Error('Valid worktree ownership metadata is required.');
  const commonDir = await realpath(ownership.commonDir);
  return join(commonDir, 'dev-now-worktrees', `${ownership.token}.json`);
}

/** Create a Git worktree and copy the current source changes into it. */
export async function createWorktree(sourceSpec, destinationName, options = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(destinationName)) throw new Error('Use a destination name without path separators.');
  const sourceCwd = await realpath(typeof sourceSpec === 'string' ? sourceSpec : sourceSpec.cwd);
  const sourceRoot = await realpath(await text(sourceCwd, ['rev-parse', '--show-toplevel']));
  const commonDir = await realpath(await text(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const branch = options.branch ?? destinationName;
  if (branch.startsWith('-')) throw new Error('The branch cannot start with a hyphen.');
  await git(sourceRoot, ['check-ref-format', '--branch', branch]);
  const branches = names(await git(sourceRoot, ['for-each-ref', '--format=%(refname)%00', `refs/heads/${branch}`]));
  if (branches.some(value => value.trim() === `refs/heads/${branch}`)) throw new Error(`Branch ${branch} already exists.`);
  const head = await text(sourceRoot, ['rev-parse', '--verify', '--end-of-options', `${options.ref ?? 'HEAD'}^{commit}`]);
  const tracked = names(await git(sourceRoot, ['ls-tree', '-rz', '--name-only', head]));
  if (tracked.some(credential)) throw new Error('The selected ref tracks credential files. Remove those files from Git before creating a fork.');
  const requested = resolve(options.path ?? join(dirname(sourceRoot), destinationName));
  const parent = await realpath(dirname(requested));
  const destination = join(parent, basename(requested));
  if (inside(sourceRoot, destination)) throw new Error('Create the worktree outside the source repository.');
  await absent(destination);
  // Git resolves repository boundaries and refs. Never copy .git directories.
  const changed = options.copyChanges === false ? [] : names(await git(sourceRoot, ['diff', 'HEAD', '--name-only', '--no-renames', '-z']));
  const untracked = options.copyChanges === false ? [] : names(await git(sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z']));
  const omittedPaths = [...changed, ...untracked].filter(excluded);
  const safeChanges = changed.filter(path => !excluded(path));
  const patch = safeChanges.length ? await git(sourceRoot, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--', ...safeChanges.map(path => `:(literal)${path}`)]) : null;
  const ownership = { version: 1, token: randomUUID(), commonDir, path: destination, branch, head, sourceRoot };
  let added = false, reserved = false, saved = false, branchCreated = false;
  try {
    await mkdir(destination);
    reserved = true;
    await git(sourceRoot, ['branch', '--', branch, head]);
    branchCreated = true;
    await git(sourceRoot, ['worktree', 'add', '--', destination, branch]);
    added = true;
    await mkdir(join(commonDir, 'dev-now-worktrees'), { recursive: true, mode: 0o700 });
    await writeFile(await recordPath(ownership), JSON.stringify(ownership), { flag: 'wx', mode: 0o600 });
    saved = true;
    if (patch?.length) await git(destination, ['apply', '--binary', '--whitespace=nowarn', '-'], patch);
    for (const path of untracked.filter(path => !excluded(path))) {
      if (!await copySourceFile(sourceRoot, destination, path)) omittedPaths.push(path);
    }
    const cwd = join(destination, relative(sourceRoot, sourceCwd));
    if (!(await lstat(cwd)).isDirectory() || !inside(destination, await realpath(cwd))) throw new Error('The selected ref does not provide the source working directory.');
    return { cwd, ownership, omittedPaths };
  } catch (error) {
    try {
      const registered = reserved && names(await git(sourceRoot, ['worktree', 'list', '--porcelain', '-z'])).includes(`worktree ${destination}`);
      if (added || registered) {
        await git(sourceRoot, ['worktree', 'remove', '--force', '--', destination]);
      } else if (reserved) await rmdir(destination).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
      // Delete only the new branch, and only while it still points at the original commit.
      if (branchCreated) await git(sourceRoot, ['update-ref', '-d', `refs/heads/${branch}`, head]);
      if (saved) await rm(await recordPath(ownership));
    } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

/** Remove a recorded worktree. Set dirty: 'discard' to explicitly discard its files. */
export async function removeOwnedWorktree(result, options = {}) {
  const ownership = result.ownership ?? result;
  const file = await recordPath(ownership);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (JSON.stringify(saved) !== JSON.stringify(ownership)) throw new Error('The worktree ownership metadata does not match the saved record.');
  const path = await realpath(saved.path);
  if (path !== saved.path || path === saved.sourceRoot) throw new Error('The owned worktree path changed.');
  const commonDir = await realpath(await text(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const root = await realpath(await text(path, ['rev-parse', '--show-toplevel']));
  const branch = await text(path, ['symbolic-ref', '--quiet', 'HEAD']);
  if (root !== path || commonDir !== saved.commonDir || branch !== `refs/heads/${saved.branch}`) throw new Error('Git does not identify this checkout as the owned worktree.');
  const status = await git(path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '-z']);
  if (status.length && options.dirty !== 'discard') throw new Error('The worktree is dirty. Preserve its files or explicitly select dirty: discard.');
  if (options.checkOnly) return { checked: path };
  const head = await text(path, ['rev-parse', 'HEAD']);
  await git(commonDir, ['worktree', 'remove', ...(options.dirty === 'discard' ? ['--force'] : []), '--', path]);
  let branchRetained = head !== saved.head;
  if (!branchRetained) {
    try { await git(commonDir, ['update-ref', '-d', `refs/heads/${saved.branch}`, saved.head]); }
    catch { branchRetained = true; }
  }
  await rm(file);
  return { removed: path, branchRetained };
}
