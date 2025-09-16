import { CfEnv } from '@workers-turbo/types'
import { Hono } from 'hono'

interface Env extends CfEnv {
}

const app = new Hono<{
  Bindings: Env
}>().basePath('/fetch-worker')

app.get('/get-result', async (c) => {
  return c.text('Hello from fetch worker!')
})

export default app
