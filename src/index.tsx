import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { renderer } from './renderer'

// Types for Cloudflare Bindings
export type CloudflareBindings = {
  DB: D1Database
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
  DISCORD_WEBHOOK_URL?: string
  INGEST_HMAC_SECRET?: string
}

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.use('/api/*', cors())
app.use(renderer)

// Health
app.get('/api/health', (c) => c.json({ ok: true }))

// Utilities
function jsonStr(o: unknown) {
  return JSON.stringify(o)
}

// Basic validation
function requiredFields(body: any, keys: string[]): string | null {
  for (const k of keys) if (!(k in body)) return k
  return null
}

// Simple HMAC verification (body||timestamp)
async function verifyHmac(c: any, rawBody: string) {
  const secret = c.env.INGEST_HMAC_SECRET
  const ts = c.req.header('x-timestamp')
  const sig = c.req.header('x-signature')
  if (!secret || !ts || !sig) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const data = encoder.encode(rawBody + ts)
  const signature = await crypto.subtle.sign('HMAC', key, data)
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return hex === sig
}

// POST /api/signals (ingestion)
app.post('/api/signals', async (c) => {
  const raw = await c.req.text()
  const ok = await verifyHmac(c, raw)
  if (!ok) return c.json({ error: 'invalid_signature' }, 401)
  const body = JSON.parse(raw)
  const missing = requiredFields(body, [
    'id','platform','round_id','timestamp','predicted_class','confidence','model_version','recommended_action','created_at'
  ])
  if (missing) return c.json({ error: `missing_${missing}` }, 400)

  // Insert into D1
  const stmt = c.env.DB.prepare(`
    INSERT INTO signals (
      id, platform, round_id, timestamp, predicted_class, predicted_multiplier,
      confidence, model_version, recommended_action, suggested_bet_pct,
      cashout_targets, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const res = await stmt.bind(
    body.id,
    body.platform,
    body.round_id,
    body.timestamp,
    body.predicted_class,
    body.predicted_multiplier ?? null,
    body.confidence,
    body.model_version,
    body.recommended_action,
    body.suggested_bet_pct ?? null,
    body.cashout_targets ? jsonStr(body.cashout_targets) : null,
    body.source ?? 'inference',
    body.created_at
  ).run()

  return c.json({ ok: true, changes: res.meta.changes })
})

// GET /api/signals/latest
app.get('/api/signals/latest', async (c) => {
  const platform = c.req.query('platform')
  const limit = Number(c.req.query('limit') ?? '20')
  const base = `SELECT * FROM signals ${platform ? 'WHERE platform=?' : ''} ORDER BY timestamp DESC LIMIT ?`
  const stmt = platform ? c.env.DB.prepare(base).bind(platform, limit) : c.env.DB.prepare(base).bind(limit)
  const { results } = await stmt.all()
  return c.json({ items: results })
})

// GET /api/signals
app.get('/api/signals', async (c) => {
  const platform = c.req.query('platform')
  const from = c.req.query('from')
  const to = c.req.query('to')
  const limit = Number(c.req.query('limit') ?? '100')
  const params: any[] = []
  let where: string[] = []
  if (platform) { where.push('platform=?'); params.push(platform) }
  if (from) { where.push('timestamp>=?'); params.push(Number(from)) }
  if (to) { where.push('timestamp<=?'); params.push(Number(to)) }
  const sql = `SELECT * FROM signals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp DESC LIMIT ?`
  params.push(limit)
  const { results } = await c.env.DB.prepare(sql).bind(...params).all()
  return c.json({ items: results })
})

// GET /api/signals/:id
app.get('/api/signals/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM signals WHERE id=?').bind(id).first()
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(row)
})

// GET /api/signals/stream (SSE minimal via text/event-stream)
app.get('/api/signals/stream', async (c) => {
  const { readable, writable } = new TransformStream()
  const encoder = new TextEncoder()
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')

  // Simple poll loop (demo). In prod, use Durable Objects or queues.
  const interval = setInterval(async () => {
    const { results } = await c.env.DB.prepare('SELECT * FROM signals ORDER BY timestamp DESC LIMIT 1').all()
    if (results && results[0]) {
      const data = `data: ${JSON.stringify(results[0])}\n\n`
      await writable.getWriter().write(encoder.encode(data))
    }
  }, 2000)

  c.req.raw.signal.addEventListener('abort', () => clearInterval(interval))
  return new Response(readable)
})

// POST /api/alerts/test: send test alert to Telegram/Discord
app.post('/api/alerts/test', async (c) => {
  const payload = await c.req.json()
  const text = payload.text || 'Test alert from aviator-bot'

  let sent: any = {}
  if (c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID) {
    const tgUrl = `https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`
    const tgRes = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: c.env.TELEGRAM_CHAT_ID, text })
    })
    sent.telegram = tgRes.status
  }
  if (c.env.DISCORD_WEBHOOK_URL) {
    const dcRes = await fetch(c.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text })
    })
    sent.discord = dcRes.status
  }
  return c.json({ ok: true, sent })
})

app.get('/', (c) => {
  return c.render(<h1>aviator-bot dashboard</h1>)
})

export default app
