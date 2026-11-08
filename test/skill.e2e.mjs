import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCli } from './helpers.mjs';

const directory = await mkdtemp(join(tmpdir(), 'agent-env-test-skill-'));
const cwd = join(directory, 'project with spaces');
const home = join(directory, 'state');
await mkdir(cwd);
await writeFile(join(directory, 'npmrc'), '');
await writeFile(join(directory, 'npmrc-global'), '');
const { invoke, cli } = createCli(cwd, home, {
  DISABLE_TELEMETRY: '1',
  npm_config_cache: join(directory, 'npm-cache'),
  npm_config_userconfig: join(directory, 'npmrc'),
  npm_config_globalconfig: join(directory, 'npmrc-global'),
});
try {
  const guide = (await invoke(['skill'])).stdout;
  assert.match(guide, /name: agent-env/);
  assert.match(guide, /# Remote services and data operations/);
  assert.match(guide, /\(#remote-services-and-data-operations\)/);
  assert.deepEqual(await cli(['skill']), { name: 'agent-env', content: guide });
  assert.match((await invoke(['skill', '--help'])).stdout, /--agent NAME/);
  assert.match((await invoke(['skill', 'install', '--help'])).stdout, /--global/);
  for (const args of [['skill', 'invalid'], ['skill', '--global'], ['skill', 'install', '--json'], ['skill', 'install', 'extra']]) {
    assert.notEqual((await invoke(args, false)).code, 0);
  }

  await invoke(['skill', 'install', '--agent', 'codex', '--agent', 'claude-code', '--yes']);
  assert.deepEqual(await readdir(join(cwd, '.agents/skills')), ['agent-env']);
  const installed = join(cwd, '.agents/skills/agent-env');
  assert.equal(await realpath(join(cwd, '.claude/skills/agent-env')), await realpath(installed));
  const main = await readFile(join(installed, 'SKILL.md'), 'utf8');
  const reference = await readFile(join(installed, 'references/remote-and-data.md'), 'utf8');
  assert.equal(guide, `${main.replace('(references/remote-and-data.md)', '(#remote-services-and-data-operations)')}\n${reference}`);

  const rejected = await invoke(['skill', 'install', '--agent', 'agent-env-nonexistent-agent', '--yes'], false);
  assert.notEqual(rejected.code, 0, 'The CLI must preserve installer failure.');
  assert.match(rejected.stdout + rejected.stderr, /invalid|unknown|not found/i);
  await assert.rejects(stat(home), { code: 'ENOENT' });
  console.log('PASS: bundled skill output, JSON, real Codex and Claude Code installation, installer failure, and no daemon state.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
