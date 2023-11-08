import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()
    .get('/', (c) => c.text('Hello Luna!'))

serve(app)
