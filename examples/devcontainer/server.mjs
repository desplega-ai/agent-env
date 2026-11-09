import http from 'node:http';
http.createServer((request, response) => {
  response.setHeader('content-type', 'text/plain');
  response.end('Dev Container ready\n');
}).listen(3000, '0.0.0.0');
