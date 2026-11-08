import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

for (const directory of ['bin', 'src', 'test', 'scripts']) {
  for (const file of await readdir(directory, { recursive: true })) {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      console.error(`Remove the unit test ${join(directory, file)}. Test the public CLI instead.`);
      process.exit(1);
    }
    if (!/\.[cm]?js$/.test(file)) continue;
    const source = await readFile(join(directory, file), 'utf8');
    if (/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:node:test|vitest|jest|mocha)['"]/.test(source)) {
      console.error(`Remove the unit test framework from ${join(directory, file)}. Test the public CLI instead.`);
      process.exit(1);
    }
    const result = spawnSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
