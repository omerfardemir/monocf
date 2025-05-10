import { CfEnv, ServerService } from '@workers-turbo/types'
import {Hono} from 'hono'

interface Env extends CfEnv {
  SERVICE: ServerService,
  NAME: string
  USER: string
  API_KEY: string
  DATABASE_URL: string // from root .dev.vars
}

const app = new Hono<{
  Bindings: Env
}>()

app.get('/', async (c) => {
  const sum = await c.env.SERVICE.sum(1, 2)
  return c.text(`Hello Hono! Sum: ${sum}, Name: ${c.env.NAME}`)
})

app.get('/env', async (c) => {
  return c.json({
    user: c.env.USER, // override in worker .dev.vars
    apiKey: c.env.API_KEY, // override in worker .dev.vars
    databaseUrl: c.env.DATABASE_URL // from root .dev.vars
  })
})

export default app
