import express from 'express'
import fetch from 'node-fetch'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { HttpProxyAgent } from 'http-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import fs from 'fs'
import path from 'path'
import config from './ticket.config.js'

const app = express()
app.use(express.json())

const TARGET = config.grabTarget || 'https://ai-smart-subsidy-backend.digitalhainan.com.cn'
const ENTRY_PATH = '/hyd-queue/core/simple/entry'

function ensureLogsDir() {
  const dir = path.resolve(process.cwd(), config.logsDir || 'logs/tickets')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function formatNow() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function buildAgent(proxyUrl) {
  if (!proxyUrl) return null
  const scheme = (config.upstream?.proxyScheme || 'http').toLowerCase()
  switch (scheme) {
    case 'socks5':
      return new SocksProxyAgent(proxyUrl)
    case 'https':
      return new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: !!config.upstream?.rejectUnauthorized })
    case 'http':
    default:
      return new HttpProxyAgent(proxyUrl)
  }
}

function parseProviderResponse(json) {
  const status = String(json?.status || '')
  if (status !== '0') {
    throw new Error(`provider status ${status}`)
  }
  const list = Array.isArray(json?.list) ? json.list : []
  const proxies = list.map((item) => {
    const host = item.sever || item.server || item.ip || ''
    const port = item.port
    if (!host || !port) return null
    const scheme = (config.upstream?.proxyScheme || 'http').toLowerCase()
    return `${scheme}://${host}:${port}`
  }).filter(Boolean)
  return proxies
}

async function acquireProxies() {
  const url = config.upstream?.providerUrl
  if (!url) return []
  const timeoutMs = config.upstream?.requestTimeoutMs || 8000
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal })
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      throw new Error(`provider HTTP ${res.status}`)
    }
    let json
    try { json = text ? JSON.parse(text) : {} } catch (e) {
      throw new Error('provider returned non-JSON')
    }
    return parseProviderResponse(json)
  } finally {
    clearTimeout(to)
  }
}

function buildRequestHeaders(fromReq) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'AppPlatform': 'H5',
    'Connection': 'keep-alive',
  }
  // Forward selected headers
  const fwd = ['authorization', 'uid']
  for (const h of fwd) {
    const v = fromReq.headers[h]
    if (v) headers[h] = v
  }
  return headers
}

// Format label for logging: "直连ip" or "host:port"
function labelForProxy(p) {
  if (!p) return '直连ip'
  try {
    const u = new URL(p)
    return `${u.hostname}:${u.port || ''}`
  } catch {
    const s = String(p)
    const idx = s.indexOf('://')
    return idx >= 0 ? s.slice(idx + 3) : s
  }
}

async function fetchTicketOnce({ agent, headers, controller }) {
  const url = TARGET.replace(/\/$/, '') + ENTRY_PATH
  const timeoutMs = Number(config.requestTimeoutMs || 8000)
  const ac = controller || new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      agent,
      signal: ac.signal,
    })
    const text = await res.text().catch(() => '')
    let json
    try { json = text ? JSON.parse(text) : {} } catch { json = {} }
    const ticket = json?.data?.ticket || null
    return { ticket, raw: json, status: res.status, bodyText: text }
  } finally {
    clearTimeout(to)
  }
}

function createWavePlan(proxies, concurrency, useDirectPerWave) {
  const plan = []
  const total = Math.max(1, concurrency || 1)
  let idx = 0
  for (let i = 0; i < total; i++) {
    if (useDirectPerWave && i === 0) {
      plan.push(null) // direct
    } else {
      plan.push(proxies[idx % (proxies.length || 1)] || null)
      idx++
    }
  }
  return plan
}

function writeLogLine(file, line) {
  fs.appendFile(file, line + '\n', () => {})
}

app.get('/healthz', (_req, res) => res.status(200).send('ok'))

app.get('/ticket/entry', async (req, res) => {
  const started = Date.now()
  const logsDir = ensureLogsDir()
  const keyRaw = String(req.headers['x-proxy-key'] || 'default')
  const key = keyRaw.replace(/[^a-zA-Z0-9_-]/g, '-')
  const file = path.join(logsDir, `${key}-${new Date().toISOString().slice(0,10)}.log`)
  const cfg = config
  writeLogLine(file, `[${formatNow()}] START 并发=${cfg.concurrency} 直连每轮=${cfg.useDirectPerWave}`)

  const headers = buildRequestHeaders(req)
  const globalTimeoutMs = cfg.globalTimeoutMs || 20000
  const endAt = started + globalTimeoutMs
  const maxWaves = cfg.maxWaves || 0
  let waves = 0

  try {
    // Acquire proxies once per request (can be re-acquired on depletion if needed)
    let proxies = []
    try {
      proxies = await acquireProxies()
      writeLogLine(file, `[${formatNow()}] PROVIDER 数量=${proxies.length}`)
    } catch (e) {
      writeLogLine(file, `[${formatNow()}] PROVIDER 错误=${e.message || e}`)
    }

    while (Date.now() < endAt) {
      waves++
      if (maxWaves > 0 && waves > maxWaves) break

      // Randomize proxies per wave
      const shuffled = shuffleInPlace([...(proxies || [])])
      const plan = createWavePlan(shuffled, cfg.concurrency, cfg.useDirectPerWave)
      const controllers = plan.map(() => new AbortController())

      writeLogLine(file, `[${formatNow()}] 第${waves}轮 计划=${plan.map(p => labelForProxy(p)).join(',')}`)

      let settled = false
      let winner = null

      await Promise.race(plan.map((p, i) => (async () => {
        const agent = p ? buildAgent(p) : null
        const r = await fetchTicketOnce({ agent, headers, controller: controllers[i] }).catch(err => ({ error: err }))
        const tag = labelForProxy(p)
        const origTicket = r?.ticket
        // Simulation decision: only affects processing, not logging
        let consideredTicket = origTicket
        if (origTicket && config.simulation?.enabled) {
          const keep = Math.random() < (config.simulation?.hitKeepRate ?? 0.05)
          if (!keep) {
            consideredTicket = null
          }
        }
        // Logging uses original response/body
        const body = r?.raw !== undefined ? JSON.stringify(r.raw) : (r?.bodyText || '')
        if (origTicket) {
          writeLogLine(file, `[${formatNow()}] [${tag}] status=${r.status} ticket=HIT BODY=${body}`)
        } else {
          writeLogLine(file, `[${formatNow()}] [${tag}] status=${r?.status || 'ERR'} ticket=null BODY=${body}`)
        }
        if (consideredTicket) {
          if (!settled) {
            settled = true
            winner = r
            // cancel others
            controllers.forEach((c, j) => { if (j !== i) c.abort() })
          }
        }
      })()))

      if (settled && winner && winner.ticket) {
        const ms = Date.now() - started
        writeLogLine(file, `[${formatNow()}] 完成 用时ms=${ms}`)
        return res.json({ data: { ticket: winner.ticket }, success: true })
      }

      // No winner this wave; small delay then next wave
      const baseDelay = Number(cfg.waveDelayMs || 0)
      const jitter = Number(cfg.waveDelayJitterMs || 0)
      const extra = jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0
      await new Promise(r => setTimeout(r, baseDelay + extra))

      // Optionally re-acquire proxies if empty
      if (!proxies || proxies.length === 0) {
        try { proxies = await acquireProxies() } catch {}
      }
    }

    const elapsed = Date.now() - started
    writeLogLine(file, `[${formatNow()}] 超时 用时ms=${elapsed}`)
    return res.status(504).json({ success: false, message: 'ticket acquire timeout' })
  } catch (e) {
    const elapsed = Date.now() - started
    writeLogLine(file, `[${formatNow()}] 错误 用时ms=${elapsed} ${e.message || e}`)
    return res.status(500).json({ success: false, message: e.message || String(e) })
  }
})

const PORT = Number(process.env.TICKET_PORT || config.serverPort || 5180)
app.listen(PORT, () => {
  ensureLogsDir()
  console.log('============================================================')
  console.log(`票据服务启动: http://localhost:${PORT}`)
  console.log(`目标服务器: ${TARGET}`)
  console.log('日志目录:', path.resolve(process.cwd(), config.logsDir || 'logs/tickets'))
  console.log('============================================================\n')
}) 