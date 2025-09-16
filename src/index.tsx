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

// Helper: simple D1 rate limit (per-IP per-minute)
async function checkRateLimit(c: any, limitPerMin = 120) {
  try {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'
    const now = Date.now()
    const windowStart = Math.floor(now / 60000) * 60000
    const key = `ingest:${ip}:${windowStart}`
    const row = await c.env.DB.prepare('SELECT key, count FROM rate_limits WHERE key=?').bind(key).first<{ key: string; count: number }>()
    if (row && row.count >= limitPerMin) return false
    if (row) {
      await c.env.DB.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(key).run()
    } else {
      await c.env.DB.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)').bind(key, windowStart).run()
    }
    return true
  } catch {
    // fail open to avoid blocking
    return true
  }
}

// POST /api/signals (ingestion)
app.post('/api/signals', async (c) => {
  const raw = await c.req.text()
  const ok = await verifyHmac(c, raw)
  if (!ok) return c.json({ error: 'invalid_signature' }, 401)

  const allowed = await checkRateLimit(c, 240)
  if (!allowed) return c.json({ error: 'rate_limited' }, 429)

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

  // Optional auto-alert based on confidence threshold
  const minConf = Number((c.env as any).ALERT_MIN_CONFIDENCE ?? '0')
  if (!Number.isNaN(minConf) && body.confidence >= minConf) {
    const text = `Aviator Signal\nPlatform: ${body.platform}\nRound: ${body.round_id}\nClass: ${body.predicted_class}\nConfidence: ${Math.round(body.confidence*100)}%\nAction: ${body.recommended_action}`
    // Store alert row first
    const alertId = body.id + ':tg'
    await c.env.DB.prepare('INSERT OR IGNORE INTO alerts (id, signal_id, channel, payload, status, retries) VALUES (?, ?, ?, ?, ?, 0)')
      .bind(alertId, body.id, 'telegram', jsonStr({ text }), 'queued').run()
    // Try Telegram
    if (c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID) {
      try {
        const tgUrl = `https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`
        const tgRes = await fetch(tgUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: c.env.TELEGRAM_CHAT_ID, text }) })
        if (tgRes.ok) {
          await c.env.DB.prepare('UPDATE alerts SET status=?, sent_at=? WHERE id=?').bind('sent', Date.now(), alertId).run()
        } else {
          await c.env.DB.prepare('UPDATE alerts SET status=? WHERE id=?').bind('failed', alertId).run()
        }
      } catch {
        await c.env.DB.prepare('UPDATE alerts SET status=? WHERE id=?').bind('failed', alertId).run()
      }
    }
    // Discord
    if (c.env.DISCORD_WEBHOOK_URL) {
      const did = body.id + ':dc'
      await c.env.DB.prepare('INSERT OR IGNORE INTO alerts (id, signal_id, channel, payload, status, retries) VALUES (?, ?, ?, ?, ?, 0)')
        .bind(did, body.id, 'discord', jsonStr({ content: text }), 'queued').run()
      try {
        const dcRes = await fetch(c.env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) })
        if (dcRes.ok) {
          await c.env.DB.prepare('UPDATE alerts SET status=?, sent_at=? WHERE id=?').bind('sent', Date.now(), did).run()
        } else {
          await c.env.DB.prepare('UPDATE alerts SET status=? WHERE id=?').bind('failed', did).run()
        }
      } catch {
        await c.env.DB.prepare('UPDATE alerts SET status=? WHERE id=?').bind('failed', did).run()
      }
    }
  }

  return c.json({ ok: true, changes: res.meta.changes })
})

// GET /api/stats
app.get('/api/stats', async (c) => {
  const platform = c.req.query('platform')
  const where = platform ? 'WHERE platform=?' : ''
  const params = platform ? [platform] : []
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM signals ${where}`).bind(...params as any).first<{ n: number }>()
  const byClass = await c.env.DB.prepare(`SELECT predicted_class as class, COUNT(*) as n FROM signals ${where} GROUP BY predicted_class`).bind(...params as any).all<{ class: string; n: number }>()
  const last = await c.env.DB.prepare(`SELECT timestamp FROM signals ${where} ORDER BY timestamp DESC LIMIT 1`).bind(...params as any).first<{ timestamp: number }>()
  return c.json({ total: totalRow?.n || 0, byClass: byClass.results || [], lastTs: last?.timestamp || null })
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
  const platform = c.req.query('platform')
  const { readable, writable } = new TransformStream()
  const encoder = new TextEncoder()
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')

  // Simple poll loop (demo). In prod, use Durable Objects or queues.
  const interval = setInterval(async () => {
    const sql = `SELECT * FROM signals ${platform ? 'WHERE platform=?' : ''} ORDER BY timestamp DESC LIMIT 1`
    const stmt = platform ? c.env.DB.prepare(sql).bind(platform) : c.env.DB.prepare(sql)
    const { results } = await stmt.all()
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

// GET /api/platforms
app.get('/api/platforms', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT DISTINCT platform FROM signals ORDER BY platform').all<{ platform: string }>()
  return c.json({ items: (results || []).map((r) => r.platform) })
})

app.get('/', (c) => {
  return c.render(<h1>aviator-bot dashboard</h1>)
})

export default app
