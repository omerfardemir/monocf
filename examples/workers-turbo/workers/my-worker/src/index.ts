import { CfEnv, ServerService } from '@workers-turbo/types'
import {Hono} from 'hono'

interface Env extends CfEnv {
  SERVICE: ServerService,
  NAME: string
}

const app = new Hono<{
  Bindings: Env
}>()

app.get('/', async (c) => {
  const sum = await c.env.SERVICE.sum(1, 2)
  return c.text(`Hello Hono! Sum: ${sum}, Name: ${c.env.NAME}`)
})

export default app
