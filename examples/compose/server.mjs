import http from 'node:http';

http.createServer((request, response) => {
  response.setHeader('content-type', 'text/plain');
  response.end('Compose web is ready. Postgres is internal.\n');
}).listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
