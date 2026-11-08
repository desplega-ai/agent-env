import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { run } from './system.mjs';

const FORMAT = 'dev-now-snapshot';
const VERSION = 1;
const IMAGE = 'busybox:1.37';
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function locationInfo(location) {
  if (typeof location !== 'string' || !location) throw new Error('Specify a snapshot directory or an S3 URL.');
  if (!location.startsWith('s3://')) return { directory: resolve(location) };
  const match = /^s3:\/\/([^/]+)\/(.+?)\/*$/.exec(location);
  if (!match || /[\r\n?#]/.test(location) || match[2].split('/').some(part => part === '..' || part === '.')) throw new Error('Use s3://bucket/nonempty-prefix without query parameters.');
  return { bucket: match[1], prefix: `${match[2]}/` };
}

function aws(options, args) {
  return run(options.awsCommand ?? 'aws', [
    ...(options.endpointUrl ? ['--endpoint-url', options.endpointUrl] : []),
    '--no-cli-pager', 's3api', ...args,
  ], { env: { ...process.env, ...options.awsEnv, AWS_PAGER: '' } });
}

async function matchingContainers(provider, spec, filter) {
  const ids = (await provider.docker(spec, ['container', 'ls', '-aq', '--filter', filter])).split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  try { return JSON.parse(await provider.docker(spec, ['inspect', ...ids])); }
  catch {
    const containers = [];
    for (const id of ids) {
      try { containers.push(...JSON.parse(await provider.docker(spec, ['inspect', id]))); }
      catch (error) {
        // An unrelated temporary container can disappear between listing and inspection.
        const remaining = await provider.docker(spec, ['container', 'ls', '-aq', '--filter', `id=${id}`]);
        if (remaining.trim()) throw error;
      }
    }
    return containers;
  }
}

function serviceContainers(service) {
  return service.containers ?? (service.container ? [service.container] : []);
}

function checkStopped(info) {
  if (info.State?.Running || info.State?.Restarting || info.State?.Paused) throw new Error(`Stop service container ${info.Name ?? info.Id} before snapshot or restore.`);
  if (!['exited', 'created', 'dead'].includes(info.State?.Status)) throw new Error('The service state is unknown. Check the Docker host before snapshot or restore.');
}

async function discover(handle, provider, options) {
  const entries = Object.entries(handle.services ?? {});
  if (!entries.length) throw new Error('The handle must identify its service containers.');
  const containers = [];
  for (const [service, value] of entries) {
    const ids = serviceContainers(value);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error(`Service ${service} must identify its container or containers.`);
    for (const info of JSON.parse(await provider.docker(handle.spec, ['inspect', ...ids]))) {
      checkStopped(info);
      containers.push({ service, info });
    }
  }
  const ownIds = new Set(containers.map(({ info }) => info.Id));
  const volumeUsers = new Map();
  const volumes = new Map(), omittedMounts = [];
  for (const { service, info } of containers) {
    for (const mount of info.Mounts ?? []) {
      const omit = reason => {
        omittedMounts.push({ service, target: mount.Destination, type: mount.Type, reason });
      };
      if (mount.Type === 'bind' && (mount.Source === (handle.workspace ?? handle.spec.cwd) || mount.Source?.startsWith(`${handle.workspace ?? handle.spec.cwd}/`))) {
        omit('Source files require a separate Git worktree or source synchronization.');
        continue;
      }
      let reason;
      if (mount.Type !== 'volume' || !mount.Name) reason = 'This mount is not a managed named volume.';
      else {
        const volume = JSON.parse(await provider.docker(handle.spec, ['volume', 'inspect', mount.Name]))[0];
        const labels = volume.Labels ?? {};
        const project = info.Config?.Labels?.['com.docker.compose.project'];
        const managed = labels['dev-now.owner'] && labels['dev-now.owner'] === handle.spec.owner
          || project && labels['com.docker.compose.project'] === project;
        if (!managed) reason = 'This volume is external or has no matching ownership label.';
        else if (volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length || volume.Scope !== 'local') reason = 'This volume uses an external driver or mount options.';
        else {
          if (!volumeUsers.has(mount.Name)) volumeUsers.set(mount.Name, await matchingContainers(provider, handle.spec, `volume=${mount.Name}`));
          if (volumeUsers.get(mount.Name).some(other => !ownIds.has(other.Id) && (other.Mounts ?? []).some(item => item.Type === 'volume' && item.Name === mount.Name))) reason = 'Another container shares this volume.';
        }
      }
      if (!reason && provider.snapshotVolumeNames) {
        try { await provider.snapshotVolumeNames(handle.spec, { volumes: [{ id: 'check', mounts: [{ service, target: mount.Destination }] }] }); }
        catch (error) { reason = error.message; }
      }
      if (reason) {
        if (!options.omitUnsupportedMounts) throw new Error(`${service}:${mount.Destination}: ${reason} Create a separate backup for this mount or select omitUnsupportedMounts.`);
        omit(reason);
        continue;
      }
      let volume = volumes.get(mount.Name);
      if (!volume) {
        volume = { id: `v${volumes.size}`, sourceName: mount.Name, archive: `v${volumes.size}.tar`, mounts: [] };
        volumes.set(mount.Name, volume);
      }
      const key = Object.entries(handle.spec.services?.[service]?.volumes ?? {}).find(([, target]) => target === mount.Destination)?.[0];
      volume.mounts.push({ service, target: mount.Destination, ...(key ? { key } : {}) });
    }
  }
  return { volumes: [...volumes.values()], omittedMounts };
}

async function streamDocker(provider, spec, args, { input, output }) {
  const file = input ? await open(input, 'r') : await open(output, 'wx', 0o600);
  try {
    // Redirect bytes through OS file descriptors. The provider only captures text on stderr.
    await provider.docker(spec, args, { stdio: [input ? file.fd : 'ignore', output ? file.fd : 'ignore', 'pipe'] });
  } finally { await file.close(); }
}

async function archiveVolume(provider, spec, volume, archive, options, restore = false) {
  const token = randomUUID();
  const name = `dev-now-snapshot-${token}`;
  const args = ['run', '--rm', ...(restore ? ['-i'] : []), '--name', name, '--label', `dev-now.snapshot=${token}`, '--network', 'none', '--read-only', '--mount', `type=volume,src=${volume},dst=/data,volume-nocopy${restore ? '' : ',readonly'}`, options.image ?? IMAGE, 'tar', '-C', '/data', restore ? '-xf' : '-cf', '-', ...(restore ? [] : ['.'])];
  try { await streamDocker(provider, spec, args, restore ? { input: archive } : { output: archive }); }
  finally {
    // A failed transport can leave a helper on the remote Docker host.
    const info = await provider.docker(spec, ['inspect', name]).then(value => JSON.parse(value)[0], () => null);
    if (info?.Config?.Labels?.['dev-now.snapshot'] === token) await provider.docker(spec, ['rm', '-f', name]);
  }
}

function tarString(buffer) { return buffer.subarray(0, buffer.indexOf(0) < 0 ? buffer.length : buffer.indexOf(0)).toString('utf8'); }

function archivePath(value) {
  if (!value || value.includes('\\') || value.includes('\ufffd') || posix.isAbsolute(value) || value.split('/').includes('..')) throw new Error('The archive contains an unsafe extraction path.');
  return posix.normalize(value).replace(/\/$/, '');
}

// Validate tar records without buffering file bodies or invoking an extractor.
async function verifyTar(file) {
  let pending = Buffer.alloc(0), remaining = 0, zeros = 0, ended = false;
  let extension, longName, longLink;
  const paths = new Map();
  for await (const chunk of createReadStream(file)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length) {
      if (remaining) {
        const consumed = Math.min(remaining, pending.length);
        if (extension && extension.read < extension.size) {
          const size = Math.min(consumed, extension.size - extension.read);
          extension.chunks.push(Buffer.from(pending.subarray(0, size)));
          extension.read += size;
        }
        remaining -= consumed;
        pending = pending.subarray(consumed);
        if (!remaining && extension) {
          const body = Buffer.concat(extension.chunks);
          if (body.indexOf(0) !== body.length - 1) throw new Error('The archive contains an invalid GNU path extension.');
          const value = tarString(body);
          if (extension.type === 'L') longName = value;
          else longLink = value;
          extension = undefined;
        }
        continue;
      }
      if (pending.length < 512) break;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every(byte => byte === 0)) { zeros++; ended = true; continue; }
      if (ended) throw new Error('The archive contains data after its end marker.');
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      const checksum = tarString(header.subarray(148, 156)).trim();
      const sizeField = tarString(header.subarray(124, 136)).trim();
      if (!/^[0-7]+$/.test(checksum) || parseInt(checksum, 8) !== sum || !/^[0-7]+$/.test(sizeField)) throw new Error('The archive contains an invalid tar header.');
      const size = parseInt(sizeField, 8);
      if (!Number.isSafeInteger(size)) throw new Error('The archive file size is not supported.');
      const magic = header.subarray(257, 265).toString('latin1');
      const gnu = magic === 'ustar  \0';
      if (magic !== `ustar${String.fromCharCode(0)}00` && !gnu) throw new Error('The archive tar format is not supported.');
      if (gnu && header.subarray(345, 500).some(byte => byte !== 0)) throw new Error('The archive contains unsupported GNU metadata.');
      const type = String.fromCharCode(header[156] || 48);
      if (['L', 'K'].includes(type)) {
        if (size < 1 || size > 1024 * 1024 || type === 'L' && longName !== undefined || type === 'K' && longLink !== undefined) throw new Error('The archive contains an invalid GNU path extension.');
        extension = { type, size, read: 0, chunks: [] };
        remaining = Math.ceil(size / 512) * 512;
        continue;
      }
      if (!['0', '1', '2', '5'].includes(type)) throw new Error('The archive contains an unsupported entry. Only files, directories, and internal links are supported.');
      if (type !== '0' && size !== 0) throw new Error('The archive contains an invalid directory or link size.');
      const prefix = gnu ? '' : tarString(header.subarray(345, 500));
      const rawName = tarString(header.subarray(0, 100));
      archivePath(rawName);
      if (prefix) archivePath(prefix);
      const path = archivePath(longName ?? `${prefix ? `${prefix}/` : ''}${rawName}`);
      const target = longLink ?? tarString(header.subarray(157, 257));
      longName = undefined; longLink = undefined;
      if (path === '.' && type !== '5') throw new Error('The archive root must be a directory.');
      if (paths.has(path)) throw new Error('The archive contains duplicate extraction paths.');
      if (type === '1') {
        const linked = paths.get(archivePath(target));
        if (!linked || !['0', '1'].includes(linked.type)) throw new Error('The archive hard link does not reference an earlier regular file.');
      }
      if (type === '2') {
        if (!target || posix.isAbsolute(target) || target.includes('\\') || target.includes('\ufffd')) throw new Error('The archive contains an unsafe symbolic link.');
      }
      paths.set(path, { type, target });
      remaining = Math.ceil(size / 512) * 512;
    }
  }
  if (remaining || pending.length || zeros < 2 || longName !== undefined || longLink !== undefined) throw new Error('The archive is truncated.');
  const resolveLink = (target, base, visited) => {
    const stack = [...base];
    for (const part of target.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..') {
        if (!stack.length) throw new Error('The symbolic link leaves the volume.');
        stack.pop();
        continue;
      }
      stack.push(part);
      const path = stack.join('/'), entry = paths.get(path);
      if (entry?.type === '2') {
        if (visited.has(path) || visited.size > 64) throw new Error('The archive contains a symbolic link cycle or an excessive link chain.');
        const resolved = resolveLink(entry.target, stack.slice(0, -1), new Set([...visited, path]));
        stack.splice(0, stack.length, ...resolved);
      }
    }
    return stack;
  };
  for (const [path, entry] of paths) {
    if (entry.type === '2') resolveLink(entry.target, posix.dirname(path).split('/').filter(part => part !== '.'), new Set([path]));
    let ancestor = posix.dirname(path);
    while (ancestor !== '.') {
      if (paths.has(ancestor) && paths.get(ancestor).type !== '5') throw new Error('An archive path traverses a symbolic link or file.');
      ancestor = posix.dirname(ancestor);
    }
  }
}

async function digest(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

function validateManifest(manifest) {
  if (manifest.format !== FORMAT || manifest.version !== VERSION || !Array.isArray(manifest.volumes) || !Array.isArray(manifest.omittedMounts)) throw new Error('The snapshot manifest format or version is not supported.');
  const ids = new Set(), archives = new Set(), sources = new Set();
  for (const volume of manifest.volumes) {
    if (!/^v\d+$/.test(volume.id) || volume.archive !== `${volume.id}.tar` || !VOLUME_NAME.test(volume.sourceName)
      || ids.has(volume.id) || archives.has(volume.archive) || sources.has(volume.sourceName)
      || !Number.isSafeInteger(volume.bytes) || volume.bytes < 1024 || !/^[a-f0-9]{64}$/.test(volume.sha256)
      || !Array.isArray(volume.mounts) || !volume.mounts.length
      || volume.mounts.some(mount => typeof mount.service !== 'string' || typeof mount.target !== 'string' || !mount.target.startsWith('/'))) throw new Error('The snapshot contains an invalid volume record.');
    ids.add(volume.id); archives.add(volume.archive); sources.add(volume.sourceName);
  }
  return manifest;
}

/** Export stopped, managed Docker volumes to a new local directory or S3 prefix. */
export async function snapshotInstance(handle, location, provider, options = {}) {
  const storage = locationInfo(location);
  const discovered = await discover(handle, provider, options);
  let directory, owned = false;
  try {
    if (storage.bucket) {
      const existing = JSON.parse(await aws(options, ['list-objects-v2', '--bucket', storage.bucket, '--prefix', storage.prefix, '--max-keys', '1', '--output', 'json']));
      if (existing.Contents?.length) throw new Error('The S3 snapshot prefix already contains data. Choose a new prefix.');
      directory = await mkdtemp(join(tmpdir(), 'dev-now-snapshot-'));
    } else {
      directory = storage.directory;
      await mkdir(directory, { mode: 0o700 });
    }
    owned = true;
    const manifest = {
      format: FORMAT, version: VERSION, createdAt: new Date().toISOString(),
      source: { name: handle.spec.name, owner: handle.spec.owner, provider: handle.spec.provider },
      volumes: discovered.volumes, omittedMounts: discovered.omittedMounts,
    };
    for (const volume of manifest.volumes) {
      const file = join(directory, volume.archive);
      await archiveVolume(provider, handle.spec, volume.sourceName, file, options);
      await verifyTar(file);
      Object.assign(volume, await digest(file));
    }
    // Reject a snapshot if a service restarted during export.
    await discover(handle, provider, options);
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (storage.bucket) {
      // Conditional writes prevent races from overwriting another writer's objects.
      for (const name of [...manifest.volumes.map(volume => volume.archive), 'manifest.json']) {
        await aws(options, ['put-object', '--bucket', storage.bucket, '--key', `${storage.prefix}${name}`, '--body', join(directory, name), '--if-none-match', '*']);
      }
    }
    return { location, manifest };
  } catch (error) {
    if (owned && !storage.bucket) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (owned && storage.bucket) await rm(directory, { recursive: true, force: true });
  }
}

async function destinationVolumes(spec, manifest, provider, options) {
  const names = new Set();
  const mapped = options.volumeNames ?? await provider.snapshotVolumeNames?.(spec, manifest);
  return manifest.volumes.map(volume => {
    let name = mapped?.[volume.id];
    if (!name) {
      const destinations = volume.mounts.map(mount => {
        const key = Object.entries(spec.services?.[mount.service]?.volumes ?? {}).find(([, target]) => target === mount.target)?.[0];
        return key && typeof provider.volume === 'function' ? provider.volume(spec, mount.service, key) : undefined;
      });
      if (destinations.some(item => !item) || new Set(destinations).size !== 1) throw new Error(`Set volumeNames.${volume.id} to the destination volume name. Match all mounts of this volume.`);
      name = destinations[0];
    }
    if (!VOLUME_NAME.test(name) || names.has(name)) throw new Error('Destination volumes must have distinct valid Docker volume names.');
    names.add(name);
    return { ...volume, destinationName: name };
  });
}

/** Restore verified archives into new volumes. This function never starts services. */
export async function restoreSnapshot(spec, location, provider, options = {}) {
  const storage = locationInfo(location);
  const directory = await mkdtemp(join(tmpdir(), 'dev-now-restore-'));
  const created = [], token = randomUUID();
  try {
    const fetch = async name => {
      const file = join(directory, name);
      if (storage.bucket) await aws(options, ['get-object', '--bucket', storage.bucket, '--key', `${storage.prefix}${name}`, file]);
      else await pipeline(createReadStream(join(storage.directory, name)), createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      return file;
    };
    const manifestFile = await fetch('manifest.json');
    if ((await stat(manifestFile)).size > 4 * 1024 * 1024) throw new Error('The snapshot manifest exceeds 4 MiB.');
    const manifest = validateManifest(JSON.parse(await readFile(manifestFile, 'utf8')));
    // Verify every archive before allocating any destination resource.
    for (const volume of manifest.volumes) {
      const file = await fetch(volume.archive);
      const actual = await digest(file);
      if (actual.sha256 !== volume.sha256 || actual.bytes !== volume.bytes) throw new Error(`Checksum or size mismatch for ${volume.archive}.`);
      await verifyTar(file);
    }
    if (options.destinationHandle) await discover(options.destinationHandle, provider, { omitUnsupportedMounts: true });
    const volumes = await destinationVolumes(spec, manifest, provider, options);
    const prefix = typeof provider.prefix === 'function' ? provider.prefix(spec) : undefined;
    const containers = [
      ...(prefix ? await matchingContainers(provider, spec, `name=${prefix}`) : []),
      ...(options.composeProject ? await matchingContainers(provider, spec, `label=com.docker.compose.project=${options.composeProject}`) : []),
    ];
    for (const info of containers) {
      if (prefix && (info.Name === `/${prefix}` || info.Name?.startsWith(`/${prefix}-`))
        || options.composeProject && info.Config?.Labels?.['com.docker.compose.project'] === options.composeProject) checkStopped(info);
    }
    const existing = new Set((await provider.docker(spec, ['volume', 'ls', '-q'])).split(/\s+/).filter(Boolean));
    for (const volume of volumes) if (existing.has(volume.destinationName)) throw new Error(`Volume ${volume.destinationName} already exists. Restore requires new destination volumes.`);
    for (const volume of volumes) {
      // Docker volume create is idempotent. A unique claim label detects a concurrent creator.
      created.push(volume.destinationName);
      const labels = provider.snapshotVolumeLabels?.(spec, volume.destinationName) ?? {};
      await provider.docker(spec, ['volume', 'create', '--label', `dev-now.owner=${spec.owner}`, '--label', `dev-now.restore=${token}`,
        ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), volume.destinationName]);
      const info = JSON.parse(await provider.docker(spec, ['volume', 'inspect', volume.destinationName]))[0];
      if (info.Labels?.['dev-now.restore'] !== token) throw new Error('Another operation created the destination volume. Restore stopped without modifying it.');
      await archiveVolume(provider, spec, volume.destinationName, join(directory, volume.archive), options, true);
    }
    return { location, manifest, volumes, restoreId: token, volumeNames: Object.fromEntries(volumes.map(volume => [volume.id, volume.destinationName])) };
  } catch (error) {
    const cleanupErrors = [];
    for (const name of created.reverse()) {
      try {
        const info = JSON.parse(await provider.docker(spec, ['volume', 'inspect', name]))[0];
        if (info.Labels?.['dev-now.restore'] === token) await provider.docker(spec, ['volume', 'rm', name]);
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) error.cleanupErrors = cleanupErrors;
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function disposeRestoredVolumes(result, spec, provider) {
  for (const volume of result.volumes) {
    const info = JSON.parse(await provider.docker(spec, ['volume', 'inspect', volume.destinationName]))[0];
    if (info.Labels?.['dev-now.restore'] !== result.restoreId) throw new Error('The restored volume ownership changed. Cleanup stopped.');
    await provider.docker(spec, ['volume', 'rm', volume.destinationName]);
  }
}
