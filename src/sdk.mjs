import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/agent-env.mjs', import.meta.url));
const providers = ['docker', 'compose', 'devcontainer', 'sandbox', 'e2b'];
const startupKeys = ['name', 'provider', 'adapter', 'ssh', 'sshConfig', 'local', 'cloud', 'cloudType', 'location', 'idleMinutes', 'ttlHours', 'config', 'environment', 'envFiles', 'composeFiles', 'profiles', 'watch', 'startupTimeoutSeconds', 'command', 'port', 'image'];

export class AgentEnvError extends Error {
  constructor(message, { code = 'CLI_FAILED', exitCode, stderr } = {}) {
    super(message);
    this.name = 'AgentEnvError';
    this.code = code;
    if (exitCode !== undefined) this.exitCode = exitCode;
    if (stderr !== undefined) this.stderr = stderr;
  }
}

function invalid() {
  throw new AgentEnvError('An SDK argument is invalid. Check the documented types and constraints.', { code: 'INVALID_ARGUMENT' });
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => !keys.includes(key))) invalid();
  return value;
}
function string(value, { argument = false, empty = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || !empty && !value.trim() || !argument && value.startsWith('-')) invalid();
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) invalid();
  return value;
}
function boolean(value) { if (typeof value !== 'boolean') invalid(); return value; }
function number(value, min, max = Number.MAX_SAFE_INTEGER, integer = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) invalid();
  return value;
}
function strings(value, { arguments: args = false, nonempty = false } = {}) {
  if (!Array.isArray(value) || nonempty && !value.length) invalid();
  return Array.from(value, item => string(item, { argument: args, empty: args }));
}
function argv(value) {
  const result = strings(value, { arguments: true, nonempty: true });
  if (!result[0]) invalid();
  return result;
}
function flags(options, fields) {
  const result = [];
  for (const [key, flag, validate = string] of fields) {
    if (options[key] !== undefined) result.push(flag, String(validate(options[key])));
  }
  return result;
}
function startup(options) {
  if (options.provider !== undefined && !providers.includes(options.provider)) invalid();
  if (options.cloud !== undefined && options.cloud !== 'hetzner') invalid();
  if (options.local !== undefined) boolean(options.local);
  if ([options.ssh !== undefined, options.cloud !== undefined, options.local === true].filter(Boolean).length > 1) invalid();
  const result = flags(options, [
    ['name', '--name', name], ['provider', '--provider'], ['adapter', '--adapter'], ['ssh', '--ssh'], ['sshConfig', '--ssh-config'],
    ['cloud', '--cloud'], ['cloudType', '--cloud-type'], ['location', '--location'],
    ['idleMinutes', '--idle-minutes', value => number(value, 0, Number.MAX_SAFE_INTEGER / 60000, false)],
    ['ttlHours', '--ttl-hours', value => number(value, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER / 3600000, false)],
    ['config', '--config'], ['environment', '--env', name], ['port', '--port', value => number(value, 1024, 65535)],
    ['image', '--image'], ['startupTimeoutSeconds', '--timeout', value => number(value, 1, 3600)],
  ]);
  if (options.local) result.push('--local');
  if (options.watch !== undefined && !boolean(options.watch)) result.push('--no-watch');
  if (options.envFiles === false) result.push('--no-env-file');
  else if (options.envFiles !== undefined) {
    const files = strings(options.envFiles, { nonempty: true });
    for (const file of files) result.push('--env-file', file);
  }
  for (const [key, flag] of [['composeFiles', '--compose-file'], ['profiles', '--profile']]) {
    if (options[key] !== undefined) for (const item of strings(options[key], { nonempty: true })) result.push(flag, item);
  }
  if (options.command !== undefined) result.push('--', ...argv(options.command));
  return result;
}
function storage(options) {
  const result = flags(options, [['endpoint', '--endpoint'], ['config', '--config']]);
  if (options.omitUnsupportedMounts !== undefined && boolean(options.omitUnsupportedMounts)) result.push('--omit-mounts');
  return result;
}
function service(options) {
  object(options, ['service']);
  return flags(options, [['service', '--service']]);
}

export function createClient(options) {
  object(options, ['cwd', 'home', 'env', 'maxOutputBytes', 'includeErrorOutput']);
  const cwd = resolve(string(options.cwd, { argument: true }));
  const home = options.home === undefined ? undefined : resolve(cwd, string(options.home, { argument: true }));
  const overrides = {};
  if (options.env !== undefined) {
    if (!options.env || typeof options.env !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options.env))) invalid();
    for (const key of Reflect.ownKeys(options.env)) {
      if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) invalid();
      const value = options.env[key];
      if (value !== undefined) string(value, { argument: true, empty: true });
      Object.defineProperty(overrides, key, { value, enumerable: true });
    }
  }
  const maxOutputBytes = options.maxOutputBytes === undefined ? 64 * 1024 * 1024 : number(options.maxOutputBytes, 1);
  const includeErrorOutput = options.includeErrorOutput === undefined ? false : boolean(options.includeErrorOutput);
  function invoke(args) {
    const env = { ...process.env, ...overrides };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
    }
    if (home !== undefined) env.AGENT_ENV_HOME = home;
    return new Promise((resolveResult, reject) => {
      let child;
      try { child = spawn(process.execPath, [cli, '--json', ...args], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { reject(new AgentEnvError('The SDK could not start the bundled CLI.', { code: 'TRANSPORT_ERROR' })); return; }
      const output = [], errors = [];
      let bytes = 0, exceeded = false, killTimer;
      const collect = (chunk, stdout) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          if (!exceeded) {
            exceeded = true;
            output.length = 0;
            errors.length = 0;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
            killTimer.unref();
          }
        } else if (!exceeded) {
          if (stdout) output.push(chunk);
          else if (includeErrorOutput) errors.push(chunk);
        }
      };
      child.stdout.on('data', chunk => collect(chunk, true));
      child.stderr.on('data', chunk => collect(chunk, false));
      child.once('error', () => reject(new AgentEnvError('The SDK could not start the bundled CLI.', { code: 'TRANSPORT_ERROR' })));
      child.once('close', exitCode => {
        clearTimeout(killTimer);
        if (exceeded) reject(new AgentEnvError('CLI output exceeded maxOutputBytes. The remote operation may continue.', { code: 'OUTPUT_LIMIT' }));
        else if (exitCode !== 0) reject(new AgentEnvError('The agent-env CLI operation failed.', {
          code: 'CLI_FAILED', ...(exitCode === null ? {} : { exitCode }),
          ...(includeErrorOutput ? { stderr: Buffer.concat(errors).toString('utf8') } : {}),
        }));
        else {
          try { resolveResult(JSON.parse(Buffer.concat(output).toString('utf8'))); }
          catch { reject(new AgentEnvError('The bundled CLI returned invalid JSON.', { code: 'INVALID_RESPONSE' })); }
        }
      });
    });
  }
  return Object.freeze({
    async up(options = {}) {
      object(options, startupKeys);
      return invoke(['up', ...startup(options)]);
    },
    async resume(instance, options = {}) {
      object(options, ['startupTimeoutSeconds']);
      return invoke(['up', name(instance), ...flags(options, [['startupTimeoutSeconds', '--timeout', value => number(value, 1, 3600)]])]);
    },
    async list() { return invoke(['list']); },
    async down(instance) { return invoke(['down', name(instance)]); },
    async remove(instance, options = {}) {
      object(options, ['purge', 'acceptUncertain']);
      const purge = options.purge === undefined ? false : boolean(options.purge);
      const acceptUncertain = options.acceptUncertain === undefined ? false : boolean(options.acceptUncertain);
      return invoke(['rm', name(instance), ...(purge ? ['--purge'] : []), ...(acceptUncertain ? ['--accept-uncertain'] : [])]);
    },
    async exec(instance, command, options = {}) {
      return invoke(['exec', name(instance), ...service(options), '--', ...argv(command)]);
    },
    async run(instance, commandName, args = [], options = {}) {
      return invoke(['run', name(instance), name(commandName), ...service(options), '--', ...strings(args, { arguments: true })]);
    },
    async logs(instance, options = {}) { return invoke(['logs', name(instance), ...service(options)]); },
    async sync(instance) { return invoke(['sync', name(instance)]); },
    async snapshot(instance, location, options = {}) {
      object(options, ['endpoint', 'config', 'omitUnsupportedMounts']);
      return invoke(['snapshot', name(instance), string(location), ...storage(options)]);
    },
    async restore(location, options) {
      object(options, [...startupKeys, 'endpoint', 'omitUnsupportedMounts']);
      name(options.name);
      const args = startup(options);
      const separator = args.indexOf('--');
      args.splice(separator < 0 ? args.length : separator, 0, ...storage({ endpoint: options.endpoint, omitUnsupportedMounts: options.omitUnsupportedMounts }));
      return invoke(['restore', string(location), ...args]);
    },
    async fork(source, destination, options = {}) {
      object(options, ['worktree', 'branch', 'ref', 'omitUnsupportedMounts']);
      return invoke(['fork', name(source), name(destination), ...flags(options, [['worktree', '--worktree'], ['branch', '--branch'], ['ref', '--ref']]), ...storage({ omitUnsupportedMounts: options.omitUnsupportedMounts })]);
    },
    async stopDaemon() { return invoke(['daemon', 'stop']); },
  });
}
