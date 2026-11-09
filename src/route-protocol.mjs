const httpPorts = new Set([80, 3000, 4173, 4200, 4321, 5000, 5173, 8000, 8080, 8081, 8888, 9000]);

export function routeProtocol(port, explicit, hint) {
  const protocol = explicit ?? hint ?? (httpPorts.has(Number(port)) ? 'http' : 'tcp');
  if (!['http', 'tcp'].includes(protocol)) throw new Error(`Set the route protocol for port ${port} to http or tcp.`);
  return protocol;
}
