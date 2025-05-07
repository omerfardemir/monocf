import {Hono} from 'hono'
import {CfEnv} from '@workers-turbo/types'
import {ServerService} from '@workers-turbo/types'

interface Env extends CfEnv {
  SERVICE: ServerService
}

const app = new Hono<{
  Bindings: Env
}>()

app.get('/', async (c) => {
  const sum = await c.env.SERVICE.sum(1, 2)
  return c.text(`Hello Hono! Sum: ${sum}`)
})

export default app
