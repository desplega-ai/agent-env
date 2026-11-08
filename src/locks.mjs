import { link, open, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { delay } from './system.mjs';

const busy = () => Object.assign(new Error('The resource is busy or locked. Retry after the active operation finishes.'), { code: 'ELOCKED' });

// Publish a complete owner file atomically. A crash cannot expose an empty lock.
async function publish(path) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(String(process.pid)); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function acquire(path, depth = 0) {
  if (depth > 32) throw busy();
  try { await publish(path); return; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const recovery = `${path}.recovery`;
  // Recovery locks use the same protocol, including recovery after their owner dies.
  await acquire(recovery, depth + 1);
  try {
    let contents;
    try { contents = await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (contents !== undefined) {
      const pid = Number(contents);
      if (!contents.trim()) {
        if (Date.now() - (await stat(path)).mtimeMs < 5000) throw busy();
      } else {
        if (!Number.isSafeInteger(pid) || pid <= 0) throw busy();
        try { process.kill(pid, 0); throw busy(); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await rm(path, { force: true });
    }
    try { await publish(path); }
    catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
  } finally { await rm(recovery, { force: true }); }
}

export async function withFileLock(path, work, { waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { await acquire(path); break; }
    catch (error) {
      if (error.code !== 'ELOCKED' || Date.now() >= deadline) throw error;
      await delay(50);
    }
  }
  try { return await work(); }
  finally { await rm(path, { force: true }); }
}
