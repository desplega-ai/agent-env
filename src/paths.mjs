import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
export const home = resolve(process.env.AGENT_ENV_HOME ?? join(homedir(), '.local/state/agent-env'));
export const socketPath = join(home, 'control.sock');
export const statePath = join(home, 'state.json');
