interface Env {
  GREETING: string
  ORDERS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/orders') return env.ORDERS.fetch(request)
    return new Response(env.GREETING)
  },
}
