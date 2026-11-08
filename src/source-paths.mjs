// Unanchored rules apply at every depth. Leading slashes anchor rules to the checkout root.
export const sourceExclusions = Object.freeze(['.git', 'node_modules', '.dev-now', '.env', '.env.*', '/.next', '/dist', '/build', '/coverage', '/.cache']);
export const worktreeExclusions = Object.freeze(['/vendor', '/target', '/.nuxt', '/.turbo', '/.venv', '/venv', '/__pycache__']);

export function shouldSync(file, exclusions = []) {
  if (!file) return true;
  const path = String(file).replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = path.split('/');
  const excluded = [...sourceExclusions, ...exclusions].some(rule => {
    if (rule.startsWith('/')) return path === rule.slice(1) || path.startsWith(`${rule.slice(1)}/`);
    if (rule.endsWith('*')) return parts.some(part => part.startsWith(rule.slice(0, -1)));
    return parts.includes(rule) || path.startsWith(`${rule}/`);
  });
  return !excluded;
}
