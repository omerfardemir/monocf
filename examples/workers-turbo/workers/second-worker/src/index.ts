import { WorkerEntrypoint } from "cloudflare:workers";

export default class ServerService extends WorkerEntrypoint {
  async fetch() { return new Response(null, { status: 404 }); }
  sum(a: number, b: number) {
    return a + b;
  }
}