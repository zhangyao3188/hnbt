// Lightweight local proxy server for /grab → remote target
// Usage: node server.proxy.js
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import fetch from 'node-fetch'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { HttpProxyAgent } from 'http-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import config from './proxy.config.js'

const app = express()

// Configurable via env or config file
const PORT = Number(process.env.PROXY_PORT || config.serverPort || 5179)
const TARGET = process.env.GRAB_TARGET || config.grabTarget || 'https://ai-smart-subsidy-backend.digitalhainan.com.cn'

// Upstream proxy state
// Per-session (x-proxy-key) mapping: { key: { url, expireAt, lastUsed, requestCount } }
const sessionProxyMap = new Map()

// Request tracking for logging
const requestStats = {
  lastRequests: new Map(), // key -> { proxyIp, response, timestamp }
  totalRequests: 0
}

function parseProviderResponse(json) {
  try {
    // Raw response logged only in debug mode
    const status = String(json?.status || '')
    if (status !== '0') {
      throw new Error(`provider status != 0, got status: ${status}`)
    }
    
    const count = parseInt(json?.count || '0')
    if (count === 0) {
      throw new Error('provider returned count=0, no proxies available')
    }
    
    const list = Array.isArray(json?.list) ? json.list : []
    if (list.length === 0) {
      throw new Error('provider returned empty list, no proxies available')
    }
    
    const item = list[0]
    if (!item) {
      throw new Error('provider list first item is null/undefined')
    }
    
    const host = item.sever || item.server || item.ip || ''
    const port = item.port
    if (!host || !port) {
      throw new Error(`provider missing host/port, got host="${host}" port="${port}"`)
    }
    
    const scheme = (config.upstream?.proxyScheme || 'http').toLowerCase()
    const proxyUrl = `${scheme}://${host}:${port}`
    const expireStr = json.expire // 'YYYY-MM-DD HH:mm:ss'
    const expireTs = expireStr ? new Date(expireStr.replace(/-/g,'/')).getTime() : Date.now() + 60_000
    const advance = (config.upstream?.refreshBeforeExpirySec ?? 10) * 1000
    const safeExpireTs = Math.max(Date.now() + 15_000, expireTs - advance)
    
    return { proxyUrl, safeExpireTs, proxyIp: host }
  } catch (e) {
    console.error('[proxy] parse provider response failed:', e.message || e)
    throw new Error(`parse provider response failed: ${e.message || e}`)
  }
}

async function acquireProxy() {
  const url = process.env.PROXY_PROVIDER_URL || config.upstream?.providerUrl
  if (!url) throw new Error('providerUrl not configured')
  const timeoutMs = config.upstream?.requestTimeoutMs || 10000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal })
    const bodyText = await res.text().catch(() => '')
    if (!res.ok) {
      console.warn(`[proxy] provider HTTP ${res.status}: ${res.statusText}; body=${(bodyText || '').slice(0, 300)}`)
      throw new Error(`provider HTTP ${res.status}: ${res.statusText}`)
    }
    let json
    try {
      json = bodyText ? JSON.parse(bodyText) : {}
    } catch (e) {
      console.warn('[proxy] provider returned non-JSON body:', (bodyText || '').slice(0, 300))
      throw new Error('provider returned non-JSON body')
    }
    let parsed
    try {
      parsed = parseProviderResponse(json)
    } catch (e) {
      // Print full provider response for diagnosis (e.g., 未在白名单)
      console.warn('[proxy] provider response (failure):', JSON.stringify(json))
      throw e
    }
    const { proxyUrl, safeExpireTs, proxyIp } = parsed
    if (config.upstream?.validateOnAcquire) {
      await validateProxy(proxyUrl)
    }
    return { proxyUrl, safeExpireTs, proxyIp }
  } catch (error) {
    clearTimeout(timer)
    if (error.name === 'AbortError') {
      throw new Error(`proxy acquisition timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function validateProxy(proxyUrl) {
  const timeoutMs = config.upstream?.requestTimeoutMs || 10000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    let Agent, agent
    const scheme = config.upstream?.proxyScheme || 'http'
    switch (scheme) {
      case 'socks5':
        Agent = SocksProxyAgent
        agent = new Agent(proxyUrl)
        break
      case 'https':
        Agent = HttpsProxyAgent
        agent = new Agent(proxyUrl, { rejectUnauthorized: false })
        break
      case 'http':
      default:
        Agent = HttpProxyAgent
        agent = new Agent(proxyUrl)
        break
    }
    
    // Try a simple GET request to a lightweight endpoint first
    // If target doesn't support HEAD, use GET with minimal data transfer
    let testUrl = TARGET
    
    // Try different validation approaches in order of preference
    const validationMethods = [
      { method: 'HEAD', url: TARGET },
      { method: 'GET', url: TARGET, headers: { 'Range': 'bytes=0-0' } }, // Request only first byte
      { method: 'GET', url: 'https://httpbin.org/get' }, // Fallback to public test service
    ]
    
    let lastError = null
    
    for (const { method, url, headers = {} } of validationMethods) {
      try {
        const res = await fetch(url, { 
          method, 
          agent, 
          signal: ac.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ...headers
          }
        })
        
        // Accept any 2xx or 3xx status as valid proxy
        if (res.status >= 200 && res.status < 400) {
          return // Validation successful
        }
        
        // If it's a 4xx error but proxy is working (not connection error), consider it valid
        if (res.status >= 400 && res.status < 500 && method === 'HEAD') {
          continue // Try next method
        }
        
        throw new Error(`validate status ${res.status}`)
      } catch (error) {
        lastError = error
        if (error.name === 'AbortError' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
          throw error // These are fatal errors, don't try other methods
        }
        // Try next validation method
        continue
      }
    }
    
    // If all methods failed, throw the last error
    throw lastError || new Error('All validation methods failed')
    
  } finally {
    clearTimeout(timer)
  }
}

async function ensureProxyFresh(key, force = false) {
  // Check if proxy is enabled
  if (!config.enableProxy) {
    return null // Direct connection
  }
  
  const now = Date.now()
  const entry = sessionProxyMap.get(key)
  
  if (force || !entry || now >= entry.expireAt) {
    const oldEntry = entry
    try {
      const { proxyUrl, safeExpireTs, proxyIp } = await acquireProxy()
      const newEntry = { 
        url: proxyUrl, 
        expireAt: safeExpireTs, 
        proxyIp,
        lastUsed: now,
        requestCount: 0
      }
      sessionProxyMap.set(key, newEntry)
      
      // Log proxy change
      if (oldEntry) {
        console.log(`[${oldEntry.proxyIp}]过期，替换为ip[${proxyIp}]`)
      } else {
        console.log(`[${proxyIp}] 新代理已获取`)
      }
      
      logProxyUsage()
    } catch (error) {
      throw error
    }
  }
  
  return sessionProxyMap.get(key)
}

// Log current proxy usage status
function logProxyUsage() {
  if (!config.enableProxy) {
    console.log('目前正在使用的代理ip：0个 (代理已禁用，使用直连)')
    return
  }
  
  const activeProxies = Array.from(sessionProxyMap.values())
  console.log(`目前正在使用的代理ip：${activeProxies.length}个`)
  
  activeProxies.forEach(entry => {
    const expireTime = new Date(entry.expireAt).toLocaleTimeString()
    console.log(`[${entry.proxyIp}]: 过期时间 ${expireTime}, 请求次数 ${entry.requestCount}`)
  })
}

// Log request details
function logRequest(key, proxyIp, responseData) {
  if (config.enableProxy && proxyIp) {
    const truncatedResponse = JSON.stringify(responseData).substring(0, 100)
    console.log(`[${proxyIp}]: ${truncatedResponse}${responseData && JSON.stringify(responseData).length > 100 ? '...' : ''}`)
  }
}

// Background proxy refresh scheduler
function startProxyRefreshScheduler() {
  if (!config.enableProxy) {
    return // No need for background refresh if proxy is disabled
  }
  
  const refreshIntervalMs = (config.upstream?.refreshBeforeExpirySec || 10) * 1000
  const checkIntervalMs = Math.min(refreshIntervalMs, 30000) // Check every 30s or refresh interval, whichever is smaller
  
  setInterval(async () => {
    const now = Date.now()
    const entries = Array.from(sessionProxyMap.entries())
    
    for (const [key, entry] of entries) {
      if (now >= entry.expireAt - 5000) { // Refresh 5 seconds before expiry
        try {
          await ensureProxyFresh(key, true)
        } catch (error) {
          console.warn(`[${entry.proxyIp}] 后台刷新失败: ${error?.message || error}`)
          sessionProxyMap.delete(key)
        }
      }
    }
  }, checkIntervalMs)
}

// Health
app.get('/healthz', (_req, res) => res.status(200).send('ok'))

// Debug endpoint to check current proxy status
app.get('/proxy-status', (_req, res) => {
  const now = Date.now()
  const status = {}
  
  for (const [key, entry] of sessionProxyMap.entries()) {
    const remainingMs = entry.expireAt - now
    status[key] = {
      proxyUrl: entry.url,
      expiresAt: new Date(entry.expireAt).toLocaleString(),
      remainingMs: remainingMs,
      isExpired: remainingMs <= 0
    }
  }
  
  res.json({
    currentTime: new Date().toLocaleString(),
    sessions: status,
    totalSessions: Object.keys(status).length
  })
})

// Proxy /grab/* to TARGET (strip /grab)
app.use('/grab', async (req, res, next) => {
  try {
    const key = String(req.headers['x-proxy-key'] || 'default')
    let entry = null
    let proxyUrl = null
    
    try {
      entry = await ensureProxyFresh(key, false)
      proxyUrl = entry?.url
      
      // Update request count and last used time
      if (entry) {
        entry.requestCount++
        entry.lastUsed = Date.now()
      }
    } catch (proxyError) {
      if (config.enableProxy) {
        console.warn(`代理获取失败，切换到直连: ${proxyError?.message || proxyError}`)
      }
      // Continue with proxyUrl = null for direct connection
    }
    
    // 根据配置选择合适的代理Agent
    let Agent, agent
    if (proxyUrl) {
      const scheme = config.upstream?.proxyScheme || 'http'
      switch (scheme) {
        case 'socks5':
          Agent = SocksProxyAgent
          agent = new Agent(proxyUrl)
          break
        case 'https':
          Agent = HttpsProxyAgent
          agent = new Agent(proxyUrl, { rejectUnauthorized: false })
          break
        case 'http':
        default:
          Agent = HttpProxyAgent
          agent = new Agent(proxyUrl)
          break
      }
    }
    
    return createProxyMiddleware({
      target: TARGET,
      changeOrigin: true,
      secure: false, // 改为 false 以避免 SSL 验证问题
      logLevel: 'silent',
      pathRewrite: {
        '^/grab': '',
      },
      agent,
      // 确保正确的 headers 转发
      headers: {
        'Connection': 'keep-alive',
      },
      onError(err, req2, res2) {
        if (config.enableProxy && entry) {
          console.warn(`[${entry.proxyIp}] 请求错误，尝试轮换代理: ${err?.message || err}`)
        }
        ensureProxyFresh(key, true).then((newEntry) => {
          const purl = newEntry?.url
          let Agent2, agent2
          if (purl) {
            const scheme = config.upstream?.proxyScheme || 'http'
            switch (scheme) {
              case 'socks5':
                Agent2 = SocksProxyAgent
                agent2 = new Agent2(purl)
                break
              case 'https':
                Agent2 = HttpsProxyAgent
                agent2 = new Agent2(purl, { rejectUnauthorized: false })
                break
              case 'http':
              default:
                Agent2 = HttpProxyAgent
                agent2 = new Agent2(purl)
                break
            }
          }
          return createProxyMiddleware({ 
            target: TARGET, 
            changeOrigin: true, 
            secure: false, 
            logLevel: 'silent', 
            pathRewrite: { '^/grab': '' }, 
            agent: agent2,
            headers: { 'Connection': 'keep-alive' }
          })(req2, res2, next)
        }).catch((retryError) => {
          console.warn('代理重试失败，切换到直连')
          return createProxyMiddleware({ 
            target: TARGET, 
            changeOrigin: true, 
            secure: false, 
            logLevel: 'silent', 
            pathRewrite: { '^/grab': '' },
            headers: { 'Connection': 'keep-alive' }
          })(req2, res2, next)
        })
      },
      onProxyReq: (proxyReq, req, res) => {
        // 确保正确的请求头
        if (!proxyReq.getHeader('Content-Type') && req.method === 'POST') {
          proxyReq.setHeader('Content-Type', 'application/json')
        }
        
        // 添加常见的浏览器请求头
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36')
        proxyReq.setHeader('Accept', 'application/json, text/plain, */*')
        proxyReq.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
        proxyReq.setHeader('Accept-Encoding', 'gzip, deflate, br')
        
        // 确保 Host 头正确
        const targetUrl = new URL(TARGET)
        proxyReq.setHeader('Host', targetUrl.host)
        
        // 如果使用代理，添加代理相关的调试信息
        if (config.enableProxy && entry) {
          console.log(`[${entry.proxyIp}] 发送请求: ${req.method} ${proxyReq.path}`)
        }
      },
      onProxyRes: (proxyRes, req, res) => {
        // Log response for active proxies
        if (config.enableProxy && entry) {
          let responseData = ''
          proxyRes.on('data', (chunk) => {
            responseData += chunk
          })
          proxyRes.on('end', () => {
            try {
              const jsonData = JSON.parse(responseData)
              logRequest(key, entry.proxyIp, jsonData)
            } catch {
              // If not JSON, log raw response
              logRequest(key, entry.proxyIp, responseData.substring(0, 100))
            }
          })
        }
      }
    })(req, res, next)
  } catch (e) {
    if (config.enableProxy) {
      console.warn('代理中间件设置失败，切换到直连')
    }
    return createProxyMiddleware({
      target: TARGET,
      changeOrigin: true,
      secure: false,
      logLevel: 'silent',
      pathRewrite: { '^/grab': '' },
      headers: { 'Connection': 'keep-alive' }
    })(req, res, next)
  }
})

app.listen(PORT, () => {
  console.log(`代理服务器启动: http://localhost:${PORT}`)
  console.log(`目标服务器: ${TARGET}`)
  console.log(`代理功能: ${config.enableProxy ? '已启用' : '已禁用 (直连模式)'}`)
  console.log(`健康检查: http://localhost:${PORT}/healthz`)
  console.log(`代理状态: http://localhost:${PORT}/proxy-status`)
  console.log('='.repeat(50))
  
  // Initial proxy status
  logProxyUsage()
  
  // Start background proxy refresh scheduler
  startProxyRefreshScheduler()
})


