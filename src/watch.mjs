import { watch, existsSync } from 'node:fs';
import { resolve, sep, basename } from 'node:path';
import { shouldSync } from './source-paths.mjs';
export { shouldSync } from './source-paths.mjs';
// The caller serializes synchronization with lifecycle changes.
export function watchSource(cwd, { changed, error = () => {}, debounceMs = 350, exclusions = [], stateDirectory } = {}) {
  let timer;
  const state = stateDirectory ? resolve(stateDirectory) : null;
  const watcher = watch(cwd, { recursive: true, persistent: false }, (_, filename) => {
    const path = resolve(cwd, filename ?? '');
    if (filename === basename(cwd) && !existsSync(path)) return;
    if (state && (path === state || path.startsWith(`${state}${sep}`))) return;
    if (!shouldSync(filename, exclusions)) return;
    clearTimeout(timer);
    timer = setTimeout(changed, debounceMs);
    timer.unref();
  });
  watcher.on('error', error);
  return () => { clearTimeout(timer); watcher.close(); };
}
