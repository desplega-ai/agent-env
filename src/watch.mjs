import { watch, existsSync } from 'node:fs';
import { resolve, sep, basename } from 'node:path';

const excluded = new Set(['.git', 'node_modules', '.dev-now', '.next', 'dist', 'build', 'coverage', '.cache']);
export function shouldSync(file, exclusions = []) {
  if (!file) return true;
  const parts = String(file).split(/[\\/]/);
  return !parts.some(part => excluded.has(part) || part === '.env' || part.startsWith('.env.')) &&
    !exclusions.some(prefix => String(file) === prefix || String(file).startsWith(`${prefix}/`));
}
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
