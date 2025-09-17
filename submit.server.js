import express from 'express'
import fetch from 'node-fetch'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { HttpProxyAgent } from 'http-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import fs from 'fs'
import path from 'path'
import config from './submit.config.js'

const app = express()
app.use(express.json())

const TARGET = config.grabTarget || 'https://ai-smart-subsidy-backend.digitalhainan.com.cn'
const SUBMIT_PATH = '/ai-smart-subsidy-approval/api/apply/submitApply'

function ensureLogsDir() {
  const dir = path.resolve(process.cwd(), config.logsDir || 'logs/submit')
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
    'Content-Type': 'application/json',
  }
  // Forward selected headers
  const fwd = ['authorization', 'uid']
  for (const h of fwd) {
    const v = fromReq.headers[h]
    if (v) headers[h] = v
  }
  return headers
}

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

async function submitOnce({ agent, headers, payload, controller }) {
  const url = TARGET.replace(/\/$/, '') + SUBMIT_PATH
  const timeoutMs = 12000
  const ac = controller || new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      agent,
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    const text = await res.text().catch(() => '')
    let json
    try { json = text ? JSON.parse(text) : {} } catch { json = {} }
    return { status: res.status, raw: json, bodyText: text }
  } finally {
    clearTimeout(to)
  }
}

function createWavePlan(proxies, perQuotaConcurrency, useDirectPerQuotaWave) {
  const total = Math.max(1, perQuotaConcurrency || 1)
  const plan = []
  let idx = 0
  for (let i = 0; i < total; i++) {
    if (useDirectPerQuotaWave && i === 0) plan.push(null)
    else {
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

// Submit API: POST /submit/apply
// payload: { uniqueId: string, tickets: string, quotas: Array<{ tourismSubsidyId, foodSubsidyId? }> }
app.post('/submit/apply', async (req, res) => {
  const started = Date.now()
  const logsDir = ensureLogsDir()
  const keyRaw = String(req.headers['x-proxy-key'] || 'default')
  const key = keyRaw.replace(/[^a-zA-Z0-9_-]/g, '-')
  const file = path.join(logsDir, `${key}-${new Date().toISOString().slice(0,10)}.log`)

  const headers = buildRequestHeaders(req)
  const { uniqueId, ticket, quotas } = req.body || {}
  if (!uniqueId || !ticket || !Array.isArray(quotas) || quotas.length === 0) {
    return res.status(400).json({ success: false, message: 'invalid payload' })
  }

  const cfg = config
  writeLogLine(file, `[${formatNow()}] START quotas=${quotas.length} 并发/档位=${cfg.perQuotaConcurrency} 直连每轮=${cfg.useDirectPerQuotaWave}`)

  const globalTimeoutMs = cfg.globalTimeoutMs || 25000
  const endAt = started + globalTimeoutMs
  const maxWaves = cfg.maxWaves || 0
  let waves = 0

  try {
    // Acquire proxies (pool)
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
      // Build per-quota plans from shuffled proxies
      const plans = quotas.map(() => createWavePlan(shuffled, cfg.perQuotaConcurrency, cfg.useDirectPerQuotaWave))

      writeLogLine(file, `[${formatNow()}] 第${waves}轮`)

      let settled = false
      let successResult = null

      await Promise.race(plans.map((plan, qIndex) => (async () => {
        const controllers = plan.map(() => new AbortController())
        const quota = quotas[qIndex]
        const basePayload = { uniqueId: String(uniqueId), tourismSubsidyId: quota.tourismSubsidyId, ticket }
        if (quota.foodSubsidyId) basePayload.foodSubsidyId = quota.foodSubsidyId

        writeLogLine(file, `[${formatNow()}]  档位${qIndex+1} 计划=${plan.map(p => labelForProxy(p)).join(',')}`)

        await Promise.race(plan.map((p, i) => (async () => {
          const agent = p ? buildAgent(p) : null
          const r = await submitOnce({ agent, headers, payload: basePayload, controller: controllers[i] }).catch(err => ({ error: err }))
          const tag = labelForProxy(p)
          const body = r?.raw !== undefined ? JSON.stringify(r.raw) : (r?.bodyText || '')

          const isSuccess = r?.raw?.success === true
          const isDuplicate = !isSuccess && typeof r?.raw?.message === 'string' && r.raw.message.includes('重复提交')

          if (isSuccess || isDuplicate) {
            if (!settled) {
              settled = true
              successResult = { quotaIndex: qIndex, isDuplicate, response: r?.raw }
              controllers.forEach((c, j) => { if (j !== i) c.abort() })
            }
            writeLogLine(file, `[${formatNow()}]  [${tag}] 档位${qIndex+1} status=${r.status} ${isDuplicate ? '重复提交' : 'SUCCESS'} BODY=${body}`)
          } else {
            const msg = r?.error ? (r.error.message || String(r.error)) : (r?.raw?.message || '未知错误')
            writeLogLine(file, `[${formatNow()}]  [${tag}] 档位${qIndex+1} status=${r?.status || 'ERR'} FAIL ${msg} BODY=${body}`)
          }
        })()))
      })()))

      if (settled && successResult) {
        const ms = Date.now() - started
        writeLogLine(file, `[${formatNow()}] 完成 用时ms=${ms} 档位=${successResult.quotaIndex+1} ${successResult.isDuplicate ? '重复提交' : '成功'}`)
        return res.json({ success: true, isDuplicate: !!successResult.isDuplicate, quotaIndex: successResult.quotaIndex, response: successResult.response })
      }

      await new Promise(r => setTimeout(r, cfg.waveDelayMs || 50))

      if (!proxies || proxies.length === 0) {
        try { proxies = await acquireProxies() } catch {}
      }
    }

    const elapsed = Date.now() - started
    writeLogLine(file, `[${formatNow()}] 超时 用时ms=${elapsed}`)
    return res.status(504).json({ success: false, message: 'submit timeout' })
  } catch (e) {
    const elapsed = Date.now() - started
    writeLogLine(file, `[${formatNow()}] 错误 用时ms=${elapsed} ${e.message || e}`)
    return res.status(500).json({ success: false, message: e.message || String(e) })
  }
})

const PORT = Number(process.env.SUBMIT_PORT || config.serverPort || 5181)
app.listen(PORT, () => {
  ensureLogsDir()
  console.log('============================================================')
  console.log(`提交服务启动: http://localhost:${PORT}`)
  console.log(`目标服务器: ${TARGET}`)
  console.log('日志目录:', path.resolve(process.cwd(), config.logsDir || 'logs/submit'))
  console.log('============================================================\n')
}) 