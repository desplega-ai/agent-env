import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('../skills/agent-env/', import.meta.url);
const help = `agent-env skill: instructions for coding agents

  agent-env skill                      Print the bundled guide and reference
  agent-env skill --json               Print the guide as JSON
  agent-env skill install              Install the bundled skill into this project
  agent-env skill install --agent codex --yes
  agent-env skill install --agent claude-code --global

Install options:
  --agent NAME                        Select an agent (repeat for multiple agents)
  -g, --global                        Install across projects
  -y, --yes                           Accept the skills installer's prompts

Reading needs no network, Docker, or daemon.
Installation runs npx skills@1.7.6 and requires Node 22.20+ and npm.
The installer uses the skill files bundled with this CLI version.
`;

export async function skillCommand(positionals, values, command) {
  if (values.help) { console.log(help); return; }
  const [action] = positionals;
  if (positionals.length > 1 || command.length || action && action !== 'install') {
    throw new Error('Use agent-env skill or agent-env skill install.');
  }
  const allowed = action ? ['agent', 'global', 'yes'] : ['json'];
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) throw new Error(`Option --${key} is not supported here. Run agent-env skill --help.`);
  }
  if (!action) {
    const guide = await readFile(new URL('SKILL.md', directory), 'utf8');
    const reference = await readFile(new URL('references/remote-and-data.md', directory), 'utf8');
    const content = `${guide.replace('(references/remote-and-data.md)', '(#remote-services-and-data-operations)')}\n${reference}`;
    if (values.json) console.log(JSON.stringify({ name: 'agent-env', content }, null, 2));
    else process.stdout.write(content);
    return;
  }
  const args = ['--yes', 'skills@1.7.6', 'add', fileURLToPath(directory), '--skill', 'agent-env'];
  for (const agent of values.agent ?? []) args.push('--agent', agent);
  if (values.global) args.push('--global');
  if (values.yes) args.push('--yes');
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn('npx', args, { stdio: 'inherit' });
    child.once('error', error => reject(new Error(`Cannot start npx: ${error.message}. Install npm, then retry.`)));
    child.once('close', code => resolve(code ?? 1));
  });
}
