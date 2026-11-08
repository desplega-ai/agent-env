import { chmod, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
function checkKey(key) {
  if (typeof key !== 'string' || !keyPattern.test(key)) throw new Error('Use a valid environment variable name.');
}
export function stringList(value, label) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some(item => typeof item !== 'string' || !item)) throw new Error(`${label} requires a string or an array of strings.`);
  return values;
}

// Values are literal. This parser never executes commands or expands variables.
export function parseEnvFile(source) {
  const result = Object.create(null);
  const lines = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid environment assignment on line ${index + 1}.`);
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      let end = -1;
      for (let cursor = 1; ; cursor++) {
        if (cursor >= value.length) {
          if (++index >= lines.length) throw new Error('An environment value has no closing quote.');
          value += `\n${lines[index]}`;
        }
        if (value[cursor] === '\\' && quote === '"') { cursor++; continue; }
        if (value[cursor] === quote) { end = cursor; break; }
      }
      if (!/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw new Error(`Invalid text after an environment value on line ${index + 1}.`);
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\([nrt"\\])/g, (_, character) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[character]);
    } else value = value.startsWith('#') ? '' : value.replace(/\s+#.*$/, '').trimEnd();
    if (value.includes('\0')) throw new Error('Environment values cannot contain null bytes.');
    result[match[1]] = value;
  }
  return result;
}

export function resolveEnvironment(config, name = 'default') {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error('Use a valid environment name.');
  const environments = config.environments ?? {};
  if (name !== 'default' && !Object.hasOwn(environments, name)) throw new Error(`Environment ${name} is not defined in dev-now.json.`);
  const { environments: ignored, ...base } = config;
  const overlay = Object.hasOwn(environments, name) ? environments[name] : {};
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) throw new Error('Environment definitions must be objects.');
  const result = { ...base, ...overlay, env: { ...base.env, ...overlay.env } };
  if (base.compose || overlay.compose) result.compose = { ...base.compose, ...overlay.compose };
  if (base.services || overlay.services) {
    result.services = { ...base.services };
    for (const [service, value] of Object.entries(overlay.services ?? {})) {
      result.services[service] = { ...base.services?.[service], ...value, env: { ...base.services?.[service]?.env, ...value.env } };
    }
  }
  return result;
}

async function storePath({ cwd = process.cwd(), environment = 'default', home } = {}) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(environment)) throw new Error('Use a valid environment name.');
  const project = await realpath(cwd);
  const digest = createHash('sha256').update(project).digest('hex');
  const root = resolve(home ?? process.env.DEV_NOW_HOME ?? join(homedir(), '.local/state/dev-now'));
  return join(root, 'secrets', digest, `${environment}.json`);
}
export async function readEnvironmentSecrets(options = {}) {
  try {
    const filename = await storePath(options);
    const file = await open(filename, 'r');
    try {
      await file.chmod(0o600);
      const values = JSON.parse(await file.readFile('utf8'));
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error();
      for (const [key, value] of Object.entries(values)) {
        checkKey(key);
        if (typeof value !== 'string' || value.includes('\0')) throw new Error();
      }
      return values;
    } finally { await file.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Cannot read the private environment store. Check its permissions and JSON structure.');
  }
}
async function writeSecrets(options, values) {
  const filename = await storePath(options);
  const directory = resolve(filename, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(values)}\n`); } finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

// Pass a readable stdin stream or a variable name. Literal value arguments are rejected.
export async function setEnvironmentSecret(options) {
  const { key, stdin, fromEnv, env = process.env } = options;
  checkKey(key);
  if (Object.hasOwn(options, 'value')) throw new Error('Read secrets from stdin or an environment reference.');
  if (Boolean(stdin) === Boolean(fromEnv)) throw new Error('Select exactly one secret source: stdin or an environment reference.');
  let value;
  if (fromEnv) {
    checkKey(fromEnv);
    if (!Object.hasOwn(env, fromEnv)) throw new Error('The source environment variable is not defined.');
    value = env[fromEnv];
  } else {
    if (typeof stdin === 'string' || !stdin[Symbol.asyncIterator]) throw new Error('Provide a readable stdin stream.');
    const chunks = [];
    let size = 0;
    for await (const chunk of stdin) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 1024 * 1024) throw new Error('The secret exceeds the one megabyte limit.');
      chunks.push(buffer);
    }
    value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Secrets must be strings without null bytes.');
  const values = await readEnvironmentSecrets(options);
  await writeSecrets(options, { ...values, [key]: value });
  return { key };
}
export async function listEnvironmentSecrets(options = {}) {
  return Object.keys(await readEnvironmentSecrets(options)).sort();
}
export async function unsetEnvironmentSecret(options) {
  checkKey(options.key);
  const values = await readEnvironmentSecrets(options);
  const existed = Object.hasOwn(values, options.key);
  delete values[options.key];
  await writeSecrets(options, values);
  return existed;
}

export async function loadEnvironment({ cwd, environment = 'default', files = [], values = {}, home, env = process.env, includeStored = true }) {
  const result = Object.create(null);
  for (const filename of stringList(files, 'env-file')) {
    Object.assign(result, parseEnvFile(await readFile(resolve(cwd, filename), 'utf8')));
  }
  const secrets = await readEnvironmentSecrets({ cwd, environment, home });
  if (includeStored) Object.assign(result, secrets);
  for (const [key, reference] of Object.entries(values)) {
    checkKey(key);
    if (typeof reference === 'string') result[key] = reference;
    else if (reference && Object.keys(reference).length === 1 && typeof reference.secret === 'string') {
      if (!Object.hasOwn(secrets, reference.secret)) throw new Error(`Private variable ${reference.secret} is not set for environment ${environment}.`);
      result[key] = secrets[reference.secret];
    } else if (reference && Object.keys(reference).length === 1 && typeof reference.env === 'string') {
      checkKey(reference.env);
      if (!Object.hasOwn(env, reference.env)) throw new Error(`Environment reference ${reference.env} is not defined.`);
      result[key] = env[reference.env];
    } else throw new Error(`Use a string, {secret: name}, or {env: name} for variable ${key}.`);
    if (typeof result[key] !== 'string' || result[key].includes('\0')) throw new Error('Environment values must be strings without null bytes.');
  }
  return result;
}

export function redactEnvironment(output, values) {
  const strings = Array.isArray(values) ? values : Object.values(values);
  let parts = [output];
  for (const value of [...new Set(strings)].filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length)) {
    parts = parts.flatMap(part => part === null ? [null] : part.split(value).flatMap((text, index) => index ? [null, text] : [text]));
  }
  return parts.map(part => part === null ? '[redacted]' : part).join('');
}
