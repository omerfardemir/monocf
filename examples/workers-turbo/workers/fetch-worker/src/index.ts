import {CfEnv} from '@workers-turbo/types'
import {Hono} from 'hono'

interface Env extends CfEnv {
  USER: string
}

const app = new Hono<{
  Bindings: Env
}>().basePath('/fetch-worker')

app.get('/get-result', async (c) => {
  return c.text(`patch monocf: ${c.env.USER}`)
})

export default app
