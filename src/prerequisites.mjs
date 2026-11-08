import { run } from './system.mjs';

export async function checkDocker({ compose = false, engine = false } = {}) {
  try {
    await run('docker', ['--version'], { timeout: 10000 });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Docker was not found. Install Docker, or use --ssh HOST with the native Docker provider. Compose also requires a local Docker CLI.');
    throw new Error('The Docker CLI could not run. Check docker --version and executable permissions.');
  }
  if (compose) {
    try { await run('docker', ['compose', 'version'], { timeout: 10000 }); }
    catch { throw new Error('Docker Compose is unavailable. Install the Compose plugin and check docker compose version.'); }
  }
  if (engine) {
    try {
      const version = JSON.parse(await run('docker', ['info', '--format', '{{json .ServerVersion}}'], { timeout: 10000 }));
      if (typeof version !== 'string' || !version.trim()) throw new Error('No Docker server version.');
    }
    catch { throw new Error('The Docker engine is unavailable. Start Docker and check docker info for the selected context and permissions.'); }
  }
}

export async function checkLocalRuntime(spec) {
  if (spec.host || spec.cloud) return;
  if (['docker', 'compose'].includes(spec.provider) || spec.provider === 'sandbox' && spec.sandbox?.adapter === 'docker') {
    await checkDocker({ compose: spec.provider === 'compose', engine: true });
  }
}
