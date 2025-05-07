import {CfEnv} from '@workers-turbo/types'
import {WorkerEntrypoint} from 'cloudflare:workers'
import {ThirdServerService} from '@workers-turbo/types'

interface Env extends CfEnv {
  SERVICE: ThirdServerService
}

export default class ServerService extends WorkerEntrypoint {
  async fetch() {
    return new Response(null, {status: 404})
  }
  sum(a: number, b: number) {
    return (this.env as Env).SERVICE.sum(a, b)
  }
}
