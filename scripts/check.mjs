import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

for (const directory of ['bin', 'src', 'test', 'scripts']) {
  for (const file of await readdir(directory, { recursive: true })) {
    if (!/\.[cm]?js$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
