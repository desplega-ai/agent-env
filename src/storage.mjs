import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { home } from './paths.mjs';
import { run } from './system.mjs';
import { redactEnvironment } from './environments.mjs';

const namePattern = /^[a-z][a-z0-9-]{0,47}$/;
const variablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const s3Fields = ['provider', 'bucket', 'endpoint', 'region', 'prefix', 'addressingStyle', 'awsProfile', 'accessKeyEnv', 'secretKeyEnv', 'sessionTokenEnv', 'caBundle'];
const secrets = new Set();
export const scrubStorage = text => redactEnvironment(String(text), [...secrets]);

function validName(name) {
  if (!namePattern.test(name ?? '')) throw new Error('Use a storage name with 1 to 48 lowercase letters, digits, or hyphens. Start with a letter.');
}
function prefix(value) {
  if (typeof value !== 'string' || !value || /[\\%?#\x00-\x20]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Use a nonempty storage prefix without traversal, escapes, or empty path segments.');
  }
  return value;
}
export function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Use an absolute HTTP or HTTPS storage endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\x00-\x20]/.test(value)) {
    throw new Error('Storage endpoints must use HTTP or HTTPS without credentials, query parameters, or fragments.');
  }
  return value;
}
function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Storage profiles must be objects.');
  const allowed = value.provider === 'local' ? ['provider', 'root'] : s3Fields;
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('The storage profile contains an unknown field.');
  for (const item of Object.values(value)) if (typeof item !== 'string' || !item || /[\x00-\x1f\x7f]/.test(item)) throw new Error('Storage profile fields must contain nonempty strings without control characters.');
  if (value.provider === 'local') {
    if (!value.root || !isAbsolute(value.root) || value.root.split('/').some(part => part === '..' || part === '.')) throw new Error('Local storage requires an absolute root without traversal.');
    return value;
  }
  if (value.provider !== 's3') throw new Error('Storage provider must be s3 or local.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(value.bucket ?? '')) throw new Error('Specify a valid S3 bucket name.');
  if (value.endpoint) validateEndpoint(value.endpoint);
  if (value.prefix) prefix(value.prefix);
  if (value.region && !/^[A-Za-z0-9-]+$/.test(value.region)) throw new Error('Specify a valid storage region.');
  if (value.addressingStyle && !['auto', 'path', 'virtual'].includes(value.addressingStyle)) throw new Error('Addressing style must be auto, path, or virtual.');
  if (value.awsProfile && !/^[A-Za-z0-9_.@-]+$/.test(value.awsProfile)) throw new Error('Specify a valid AWS profile name.');
  if (Boolean(value.accessKeyEnv) !== Boolean(value.secretKeyEnv)) throw new Error('Specify both access-key-env and secret-key-env.');
  if (value.sessionTokenEnv && !value.accessKeyEnv) throw new Error('Session-token-env requires access-key-env and secret-key-env.');
  for (const key of ['accessKeyEnv', 'secretKeyEnv', 'sessionTokenEnv']) if (value[key] && !variablePattern.test(value[key])) throw new Error('Credential references must contain environment variable names.');
  if (value.caBundle && !isAbsolute(value.caBundle)) throw new Error('The CA bundle path must be absolute.');
  return value;
}
async function readJson(file, optional = true) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return {};
    throw new Error('Cannot read storage configuration. Check the JSON structure and file permissions.');
  }
}
function validateProfiles(profiles) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new Error('Storage configuration must contain a map of named profiles.');
  for (const [name, profile] of Object.entries(profiles)) { validName(name); validateProfile(profile); }
  return profiles;
}
async function configuration(options = {}) {
  const userFile = join(home, 'storage.json');
  const projectFile = resolve(options.cwd ?? process.cwd(), options.config ?? 'agent-env.json');
  const project = await readJson(projectFile, !options.config);
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('Project configuration must contain an object.');
  const user = validateProfiles(await readJson(userFile));
  try { await chmod(userFile, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot protect the user storage configuration.'); }
  const local = validateProfiles(project.storage === undefined ? {} : project.storage);
  return { userFile, projectFile, project, user, local };
}
function publicProfile(name, profile, source) {
  const { accessKeyEnv, secretKeyEnv, sessionTokenEnv, ...safe } = profile;
  return { name, source, ...safe };
}
export async function listStorage(options = {}) {
  const { user, local } = await configuration(options);
  return Object.keys(options.project ? local : { ...user, ...local }).sort().map(name => publicProfile(name, Object.hasOwn(local, name) ? local[name] : user[name], Object.hasOwn(local, name) ? 'project' : 'user'));
}
export async function mutateStorage(action, name, values, options = {}) {
  validName(name);
  const config = await configuration(options);
  const profiles = options.project ? config.local : config.user;
  if (action === 'add') {
    if (Object.hasOwn(profiles, name)) throw new Error('This storage profile already exists. Remove it before replacement.');
    const profile = Object.fromEntries([
      ['provider', values.provider], ['root', values.root], ['bucket', values.bucket], ['endpoint', values.endpoint],
      ['region', values.region], ['prefix', values.prefix], ['addressingStyle', values['addressing-style']],
      ['awsProfile', values['aws-profile']], ['accessKeyEnv', values['access-key-env']], ['secretKeyEnv', values['secret-key-env']],
      ['sessionTokenEnv', values['session-token-env']], ['caBundle', values['ca-bundle']],
    ].filter(([, value]) => value !== undefined));
    profiles[name] = validateProfile(profile);
  } else {
    if (!Object.hasOwn(profiles, name)) throw new Error('This storage profile does not exist in the selected source.');
    delete profiles[name];
  }
  let file = options.project ? config.projectFile : config.userFile;
  let mode = 0o600;
  if (options.project) {
    try { file = await realpath(file); mode = (await stat(file)).mode & 0o777; }
    catch (error) { if (error.code !== 'ENOENT') throw error; throw new Error('Project configuration does not exist. Run agent-env init before adding project storage.'); }
  }
  if (!options.project) { await mkdir(home, { recursive: true, mode: 0o700 }); await chmod(home, 0o700); }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(options.project ? { ...config.project, storage: profiles } : profiles, null, 2)}\n`, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return { name, source: options.project ? 'project' : 'user', message: action === 'add' ? 'Storage profile added.' : 'Storage profile removed.' };
}
export async function resolveStorage(location, options = {}) {
  if (options.endpoint) validateEndpoint(options.endpoint);
  if (location.startsWith('storage://')) {
    const match = /^storage:\/\/([^/]+)\/(.+)$/.exec(location);
    if (!match) throw new Error('Use storage://NAME/nonempty-prefix.');
    validName(match[1]); prefix(match[2]);
    const config = await configuration(options);
    const source = options.project || Object.hasOwn(config.local, match[1]) ? 'project' : 'user';
    const profiles = source === 'project' ? config.local : config.user;
    if (!Object.hasOwn(profiles, match[1])) throw new Error('The storage profile does not exist. Use storage list.');
    const profile = profiles[match[1]];
    if (options.endpoint && (profile.provider !== 's3' || profile.endpoint !== options.endpoint)) throw new Error('The endpoint override conflicts with the storage profile. Edit the profile instead.');
    const path = [profile.prefix, match[2]].filter(Boolean).join('/');
    return { ...profile, location: profile.provider === 'local' ? resolve(profile.root, path) : `s3://${profile.bucket}/${path}`, name: match[1], source };
  }
  if (location.startsWith('s3://')) {
    const match = /^s3:\/\/([^/]+)\/(.+?)\/*$/.exec(location);
    if (!match) throw new Error('Use s3://bucket/nonempty-prefix.');
    const profile = validateProfile({ provider: 's3', bucket: match[1], ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
    prefix(match[2]);
    return { ...profile, location: `s3://${match[1]}/${match[2]}` };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(location)) throw new Error('Use a local path, s3://bucket/prefix, or storage://NAME/prefix.');
  if (options.endpoint) throw new Error('An endpoint requires an S3 location.');
  return { provider: 'local', location: resolve(location) };
}

// Keep other profiles, role sources, SSO sessions, and credential processes intact.
function addressingConfig(config, profile, style) {
  const section = profile === 'default' ? 'default' : `profile ${profile}`;
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1] === section);
  if (start < 0) return `${config}\n[${section}]\ns3 =\n    addressing_style = ${style}\n`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const s3 = lines.findIndex((line, index) => index > start && index < end && /^s3\s*=\s*$/.test(line));
  if (s3 < 0) lines.splice(end, 0, 's3 =', `    addressing_style = ${style}`);
  else {
    let nestedEnd = s3 + 1;
    while (nestedEnd < end && (!lines[nestedEnd].trim() || /^\s|^[#;]/.test(lines[nestedEnd]))) nestedEnd++;
    const nested = lines.slice(s3 + 1, nestedEnd).filter(line => !/^\s+addressing_style\s*=/.test(line));
    lines.splice(s3 + 1, nestedEnd - s3 - 1, `    addressing_style = ${style}`, ...nested);
  }
  return `${lines.join('\n')}\n`;
}
export async function awsStorage(options, args) {
  if (options.awsConfig !== undefined) {
    let directory, interrupted;
    const controller = new AbortController();
    const handlers = ['SIGINT', 'SIGTERM'].map((signal, index) => [signal, () => { interrupted = index === 0 ? 130 : 143; controller.abort(); }]);
    if (options.interruptible) for (const [signal, handler] of handlers) process.once(signal, handler);
    try {
      directory = await mkdtemp(join(tmpdir(), 'agent-env-storage-'));
      await chmod(directory, 0o700);
      const file = join(directory, 'config');
      await writeFile(file, options.awsConfig, { flag: 'wx', mode: 0o600 });
      return await awsStorage({ ...options, awsConfig: undefined, signal: controller.signal,
        awsEnv: { ...options.awsEnv, AWS_CONFIG_FILE: file, AWS_SHARED_CREDENTIALS_FILE: join(directory, 'no-credentials') } }, args);
    } catch (error) {
      if (interrupted) error.exitCode = interrupted;
      throw error;
    } finally {
      if (options.interruptible) for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  const privateValues = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN'].map(key => options.awsEnv?.[key]).filter(Boolean);
  try {
    return await run(options.awsCommand ?? 'aws', [
      ...(options.endpointUrl ? ['--endpoint-url', options.endpointUrl] : []),
      ...(options.region ? ['--region', options.region] : []),
      '--no-cli-pager', 's3api', ...args,
    ], { env: options.awsEnv, signal: options.signal });
  } catch (error) { throw new Error(redactEnvironment(error.message, privateValues)); }
}
export async function storageContext(storage) {
  if (storage.provider !== 's3') return {};
  const env = { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' };
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN']) if (env[key]) secrets.add(env[key]);
  if (storage.awsProfile) {
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_SESSION_NAME']) delete env[key];
    env.AWS_PROFILE = storage.awsProfile;
    delete env.AWS_DEFAULT_PROFILE;
  }
  if (storage.name) {
    delete env.AWS_ENDPOINT_URL;
    delete env.AWS_ENDPOINT_URL_S3;
    delete env.AWS_CA_BUNDLE;
    env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'true';
  }
  for (const [field, key] of [['accessKeyEnv', 'AWS_ACCESS_KEY_ID'], ['secretKeyEnv', 'AWS_SECRET_ACCESS_KEY'], ['sessionTokenEnv', 'AWS_SESSION_TOKEN']]) {
    if (!storage[field]) continue;
    const value = process.env[storage[field]];
    if (!value) throw new Error(`Storage credential reference ${storage[field]} is not defined or is empty.`);
    secrets.add(value); env[key] = value;
  }
  if (storage.accessKeyEnv) {
    delete env.AWS_SECURITY_TOKEN;
    if (!storage.sessionTokenEnv) delete env.AWS_SESSION_TOKEN;
  }
  if (storage.caBundle) env.AWS_CA_BUNDLE = storage.caBundle;
  const file = env.AWS_CONFIG_FILE ?? join(env.HOME ?? homedir(), '.aws/config');
  let config = '';
  try { config = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read the AWS configuration file.'); }
  if (storage.name) config = config.split(/\r?\n/).filter(line => !/^\s*ca_bundle\s*=/i.test(line)).join('\n');
  const profile = env.AWS_DEFAULT_PROFILE ?? env.AWS_PROFILE ?? 'default';
  if (!/^[A-Za-z0-9_.@-]+$/.test(profile)) throw new Error('Specify a valid AWS profile name.');
  if (storage.addressingStyle) config = addressingConfig(config, profile, storage.addressingStyle);
  env.AWS_SHARED_CREDENTIALS_FILE ??= join(env.HOME ?? homedir(), '.aws/credentials');
  let credentials;
  try { credentials = JSON.parse(await run('aws', ['configure', 'export-credentials', '--format', 'process'], { env })); }
  catch { throw new Error('Cannot resolve AWS credentials. Check the selected profile, credential references, login, and AWS CLI v2.'); }
  for (const [field, key] of [['AccessKeyId', 'AWS_ACCESS_KEY_ID'], ['SecretAccessKey', 'AWS_SECRET_ACCESS_KEY'], ['SessionToken', 'AWS_SESSION_TOKEN']]) {
    if (credentials[field]) { env[key] = credentials[field]; secrets.add(credentials[field]); }
    else delete env[key];
  }
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error('The AWS credential chain returned no access key or secret key.');
  // Environment credentials take precedence over named-profile credential providers.
  // Keep the selected profile's other AWS settings for the transport.
  const region = storage.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? await run('aws', ['configure', 'get', 'region'], { env }).catch(() => '');
  const transportKeys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'];
  const transportEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('AWS_') || transportKeys.includes(key)));
  delete transportEnv.AWS_SHARED_CREDENTIALS_FILE;
  delete transportEnv.AWS_CONFIG_FILE;
  delete transportEnv.AWS_SECURITY_TOKEN;
  return { endpointUrl: storage.endpoint, region: region || undefined, awsEnv: transportEnv, awsConfig: config, interruptible: true };
}

export async function checkStorage(storage, options) {
  if (storage.provider !== 's3') throw new Error('Storage check requires an S3 profile.');
  const token = randomUUID();
  const key = `${storage.prefix ? `${storage.prefix}/` : ''}.agent-env-check/${token}/probe`;
  const directory = await mkdtemp(join(tmpdir(), 'agent-env-storage-check-'));
  const body = join(directory, 'probe'), download = join(directory, 'download');
  const args = ['--bucket', storage.bucket, '--key', key];
  let attempted = false, failure;
  try {
    await writeFile(body, token, { mode: 0o600 });
    await awsStorage(options, ['list-objects-v2', '--bucket', storage.bucket, '--prefix', key, '--max-keys', '1']);
    attempted = true;
    await awsStorage(options, ['put-object', ...args, '--body', body, '--metadata', `agent-env-owner=${token}`, '--if-none-match', '*']);
    await awsStorage(options, ['get-object', ...args, download]);
    if (await readFile(download, 'utf8') !== token) throw new Error('The storage probe download differs from its upload.');
    await writeFile(body, `${token}-duplicate`, { mode: 0o600 });
    let rejected = false;
    try { await awsStorage(options, ['put-object', ...args, '--body', body, '--metadata', `agent-env-owner=${token}`, '--if-none-match', '*']); }
    catch (error) { if (/PreconditionFailed|\(412\)/.test(error.message)) rejected = true; else throw error; }
    if (!rejected) throw new Error('This backend does not reject duplicate conditional creates. Snapshots require If-None-Match support.');
    await awsStorage(options, ['get-object', ...args, download]);
    if (await readFile(download, 'utf8') !== token) throw new Error('The backend changed an object after a rejected conditional create.');
  } catch (error) { failure = error; }
  finally {
    if (attempted) {
      try {
        let head;
        try { head = JSON.parse(await awsStorage(options, ['head-object', ...args])); }
        catch (error) { if (!/NoSuchKey|\(404\)|Not Found/.test(error.message)) throw error; }
        if (head) {
          if (head.Metadata?.['agent-env-owner'] !== token) throw new Error('The probe ownership does not match.');
          await awsStorage(options, ['delete-object', ...args]);
        }
      } catch (error) {
        failure = new Error(`${failure ? `${failure.message} ` : ''}Probe cleanup failed. Recovery object: s3://${storage.bucket}/${key}. ${error.message}`);
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return { name: storage.name, source: storage.source, provider: 's3', message: 'Bucket access, upload, download, and duplicate conditional rejection passed.' };
}
