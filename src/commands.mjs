const namePattern = /^[a-z][a-z0-9-]{0,47}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateCommands(spec) {
  if (spec.commands === undefined) return;
  if (!object(spec.commands)) throw new Error('Set commands to an object of named project commands.');
  for (const [name, value] of Object.entries(spec.commands)) {
    if (!namePattern.test(name)) throw new Error('Use lowercase letters, digits, and hyphens for project command names.');
    const definition = object(value) ? value : { command: value };
    if (Object.keys(definition).some(key => !['command', 'service'].includes(key))) throw new Error(`Project command ${name} supports command and service only.`);
    const command = definition.command;
    const valid = typeof command === 'string' ? !!command.trim() && !command.includes('\0')
      : Array.isArray(command) && command.length > 0 && command.every(arg => typeof arg === 'string' && !arg.includes('\0')) && !!command[0];
    if (!valid) throw new Error(`Project command ${name} requires a shell string or a nonempty argument array.`);
    if (definition.service !== undefined && (typeof definition.service !== 'string' || !Object.hasOwn(spec.services ?? {}, definition.service))) {
      throw new Error(`Project command ${name} references an unknown service.`);
    }
  }
}

export function projectCommand(handle, name, service, args = []) {
  if (!Object.hasOwn(handle.spec.commands ?? {}, name)) throw new Error(`Project command ${name} is not defined. Add it to commands in agent-env.json.`);
  const value = handle.spec.commands[name];
  const definition = object(value) ? value : { command: value };
  const selected = service ?? definition.service ?? handle.primaryService ?? Object.keys(handle.services)[0];
  if (!Object.hasOwn(handle.services, selected)) throw new Error(`Service ${selected} does not exist.`);
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Project command arguments must contain strings without null bytes.');
  const argv = typeof definition.command === 'string'
    ? ['sh', '-c', definition.command, 'agent-env', ...args]
    : [...definition.command, ...args];
  return { service: selected, argv };
}
