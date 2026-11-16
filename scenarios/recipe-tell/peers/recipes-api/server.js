// The recipe API on PORT (default 8090): JSON over HTTP, no dependencies.
import { createServer } from 'node:http'
import { recipes } from './recipes.js'

export const routes = {
  'GET /kitchen/v2/recipe-cards': () => recipes.map(({ id, name, minutes }) => ({ id, name, minutes })),
  'GET /kitchen/v2/health': () => ({ ok: true }),
}

createServer((request, response) => {
  const route = routes[`${request.method} ${new URL(request.url, 'http://x').pathname}`]
  if (!route) return response.writeHead(404).end('Not found')
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(route()))
}).listen(Number(process.env.PORT ?? 8090), '127.0.0.1')
