import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { run } from './system.mjs';
import { home } from './paths.mjs';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { withFileLock } from './locks.mjs';

export async function ensureTls(directory = join(home, 'tls'), hosts = []) {
  if (hosts.some(host => !/^[a-z0-9][a-z0-9-]{0,62}\.localhost$/.test(host))) throw new Error('TLS names must be valid localhost hostnames.');
  hosts = [...new Set(hosts)].sort();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return withFileLock(join(directory, 'generation.lock'), () => generateTls(directory, hosts), { waitMs: 15000 });
}
async function generateTls(directory, hosts) {
  const ca = join(directory, 'ca.pem'), caKey = join(directory, 'ca.key');
  const cert = join(directory, 'server.pem'), key = join(directory, 'server.key');
  const exists = path => readFile(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (await exists(ca) !== await exists(caKey)) throw new Error('The local CA is incomplete. Restore its certificate and key before enabling HTTPS.');
  const config = join(directory, 'openssl.cnf');
  await writeFile(config, `[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=agent-env local development\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:localhost,permitted;DNS:.localhost,permitted;IP:127.0.0.1/255.255.255.255,permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:::1${hosts.map(host => `,DNS:${host}`).join('')}\n`, { mode: 0o600 });
  try {
    if (!await exists(ca)) {
      await run('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-noout', '-out', caKey]);
      await chmod(caKey, 0o600);
      await run('openssl', ['req', '-new', '-x509', '-sha256', '-key', caKey, '-out', ca, '-days', '3650', '-config', config]);
    }
    const authority = new X509Certificate(await readFile(ca));
    const publicKey = createPublicKey(createPrivateKey(await readFile(caKey))).export({ type: 'spki', format: 'der' });
    if (!authority.publicKey.export({ type: 'spki', format: 'der' }).equals(publicKey)) throw new Error('The local CA certificate and key do not match. Restore the matching pair before enabling HTTPS.');
    await run('openssl', ['x509', '-checkend', '86400', '-noout', '-in', ca]).catch(() => { throw new Error('The local CA is expired. Replace it and repeat agent-env trust.'); });
    const oldNames = await readFile(join(directory, 'names.json'), 'utf8').catch(() => '');
    const valid = oldNames === JSON.stringify(hosts) && await exists(key) && await exists(cert) && await run('openssl', ['x509', '-checkend', '86400', '-noout', '-in', cert]).then(() => true, () => false);
    if (!valid) {
      await run('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-noout', '-out', key]);
      await chmod(key, 0o600);
      const csr = join(directory, 'server.csr');
      try {
        await run('openssl', ['req', '-new', '-key', key, '-out', csr, '-subj', '/CN=localhost']);
        await run('openssl', ['x509', '-req', '-sha256', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '365', '-extfile', config, '-extensions', 'server']);
      } finally { await rm(csr, { force: true }); }
    }
    await writeFile(join(directory, 'names.json'), JSON.stringify(hosts), { mode: 0o600 });
    return { key: await readFile(key), cert: await readFile(cert), caPath: ca };
  } finally { await rm(config, { force: true }); }
}
export async function trustTls() {
  const { caPath } = await ensureTls();
  if (platform() === 'darwin') {
    await run('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', join(homedir(), 'Library/Keychains/login.keychain-db'), caPath]);
  } else if (platform() === 'linux') {
    await run('sudo', ['-n', 'install', '-m', '0644', caPath, '/usr/local/share/ca-certificates/agent-env.crt']);
    await run('sudo', ['-n', 'update-ca-certificates']);
  } else throw new Error(`Install ${caPath} in your user trust store. Automatic trust supports macOS and Debian-based Linux.`);
  return { message: `Trusted the agent-env local CA: ${caPath}` };
}
