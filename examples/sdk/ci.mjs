import { createClient } from '@desplega.ai/agent-env';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'agent-env-sdk-ci-'));
const cwd = join(directory, 'source');
const home = join(directory, 'state');
const name = `ci-${randomUUID().slice(0, 8)}`;
const client = createClient({ cwd, home });

try {
  await mkdir(cwd);
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  await writeFile(join(cwd, 'index.html'), 'SDK CI example');
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify({
    services: {
      web: {
        image: 'busybox:1.37', port, containerPort: 8080,
        command: 'httpd -f -p 8080 -h /workspace',
      },
    },
    commands: { test: ['cat', '/workspace/index.html'] },
  }));
  const instance = await client.up({ name, provider: 'docker', local: true, envFiles: false });
  console.log(instance.services.web.url);
  const result = await client.run(name, 'test');
  console.log(result.output);
} finally {
  try {
    const instances = await client.list();
    if (instances.some(instance => instance.name === name)) {
      await client.remove(name, { purge: true });
    }
  } finally {
    await client.stopDaemon();
  }
  await rm(directory, { recursive: true, force: true });
}
