import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
export const home = resolve(process.env.DEV_NOW_HOME ?? join(homedir(), '.local/state/dev-now'));
export const socketPath = join(home, 'control.sock');
export const statePath = join(home, 'state.json');
