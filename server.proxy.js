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
// Per-session (x-proxy-key) mapping: { key: { url, expireAt, lastUsed, requestCount, proxyIp, consecutiveErrors, performanceHistory, performanceAnomalies, firstReportSkipped } }
const sessionProxyMap = new Map()

// Request tracking for logging and cleanup
const sessionHistory = new Map() // key -> [{ requestCount, timestamp }, ...]
let lastStatusTime = Date.now()

// Proxy quality monitoring constants (from config)
const CONSECUTIVE_ERROR_THRESHOLD = config.qualityMonitoring?.consecutiveErrorThreshold || 5
const PERFORMANCE_REQUEST_THRESHOLD = config.qualityMonitoring?.performanceRequestThreshold || 100
const PERFORMANCE_ANOMALY_THRESHOLD = config.qualityMonitoring?.performanceAnomalyThreshold || 2

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
      console.log('============================================================')
    console.warn(`[proxy] provider HTTP ${res.status}: ${res.statusText}; body=${(bodyText || '').slice(0, 300)}`)
    console.log('============================================================\n')
      throw new Error(`provider HTTP ${res.status}: ${res.statusText}`)
    }
    let json
    try {
      json = bodyText ? JSON.parse(bodyText) : {}
    } catch (e) {
      console.log('============================================================')
    console.warn('[proxy] provider returned non-JSON body:', (bodyText || '').slice(0, 300))
    console.log('============================================================\n')
      throw new Error('provider returned non-JSON body')
    }
    let parsed
    try {
      parsed = parseProviderResponse(json)
    } catch (e) {
      // Print full provider response for diagnosis (e.g., 未在白名单)
      console.log('============================================================')
      console.warn('[proxy] provider response (failure):', JSON.stringify(json))
      console.log('============================================================\n')
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
        requestCount: 0,
        consecutiveErrors: 0,
        performanceHistory: [],
        performanceAnomalies: 0,
        firstReportSkipped: false,
        zeroRequestCount: 0
      }
      sessionProxyMap.set(key, newEntry)
      
      // Log proxy change
      if (oldEntry) {
        console.log('============================================================')
        console.log(`[${oldEntry.proxyIp}]过期，替换为ip[${proxyIp}]`)
        console.log('============================================================\n')
      } else {
        console.log('============================================================')
        console.log(`[${proxyIp}] 新代理已获取`)
        console.log('============================================================\n')
      }
      
      logProxyUsage()
    } catch (error) {
      throw error
    }
  }
  
  return sessionProxyMap.get(key)
}

// Direct connection tracking for 30s reports
let directConnectionCount = 0
let lastDirectConnectionReset = Date.now()

// Log current proxy usage status with timestamps
function logProxyUsage(scheduled = false) {
  console.log('============================================================')
  
  if (!config.enableProxy) {
    const now = new Date()
    console.log(`[${now.toLocaleTimeString()}] 目前正在使用的代理ip：0个 (代理已禁用，使用直连)`)
    console.log('============================================================\n')
    return
  }
  
  const now = new Date()
  const activeProxies = Array.from(sessionProxyMap.values())
  const nextTime = new Date(now.getTime() + 30000)
  
  console.log(`[${now.toLocaleTimeString()}] 目前正在使用的代理ip：${activeProxies.length}个${scheduled ? ` (下次输出时间: ${nextTime.toLocaleTimeString()})` : ''}`)
  
  activeProxies.forEach(entry => {
    const expireTime = new Date(entry.expireAt).toLocaleTimeString()
    console.log(`  [${entry.proxyIp}]: 过期时间 ${expireTime}, 请求次数 ${entry.requestCount}`)
  })
  
  // Show direct connection stats in 30s reports
  if (scheduled && directConnectionCount > 0) {
    console.log(`  [直连]: 请求次数 ${directConnectionCount}`)
    // Reset counter after reporting
    directConnectionCount = 0
    lastDirectConnectionReset = Date.now()
  }
  
  console.log('============================================================\n')
  
  // Record current status for cleanup tracking and performance monitoring
  if (scheduled) {
    const currentTime = Date.now()
    const proxiesToForceSwitch = []
    
    activeProxies.forEach(entry => {
      const key = getKeyByProxy(entry.url)
      if (key) {
        if (!sessionHistory.has(key)) {
          sessionHistory.set(key, [])
        }
        const history = sessionHistory.get(key)
        const lastRecord = history[history.length - 1]
        const previousCount = lastRecord ? lastRecord.requestCount : 0
        const newRequests = entry.requestCount - previousCount
        
        history.push({ requestCount: entry.requestCount, timestamp: currentTime })
        
        // Performance monitoring (skip first report)
        if (!entry.firstReportSkipped) {
          entry.firstReportSkipped = true
          console.log(`  [${entry.proxyIp}]: 过期时间 ${new Date(entry.expireAt).toLocaleTimeString()}, 请求次数 ${entry.requestCount} (首次报告，跳过性能判断)`)
        } else {
          // Check performance after first report
          const isPerformancePoor = newRequests > 0 && newRequests < PERFORMANCE_REQUEST_THRESHOLD
          const isZeroRequests = newRequests === 0
          
          if (isZeroRequests) {
            // 特殊处理：新增请求为0的情况
            entry.zeroRequestCount = (entry.zeroRequestCount || 0) + 1
            console.log(`  [${entry.proxyIp}]: 过期时间 ${new Date(entry.expireAt).toLocaleTimeString()}, 请求次数 ${entry.requestCount} (新增${newRequests}次, 连续零请求: ${entry.zeroRequestCount}次, 交由不活跃检测处理)`)
            
            // 零请求不触发强制切换，由不活跃检测(3分钟)处理
            // 清除性能异常计数，因为零请求不代表性能差
            if (entry.performanceAnomalies > 0) {
              entry.performanceAnomalies = 0
            }
          } else if (isPerformancePoor) {
            // 有请求但数量低于阈值，视为性能差
            entry.performanceAnomalies = (entry.performanceAnomalies || 0) + 1
            entry.zeroRequestCount = 0 // 重置零请求计数
            console.log(`  [${entry.proxyIp}]: 过期时间 ${new Date(entry.expireAt).toLocaleTimeString()}, 请求次数 ${entry.requestCount} (新增${newRequests}次 < ${PERFORMANCE_REQUEST_THRESHOLD}, 性能异常: ${entry.performanceAnomalies}/${PERFORMANCE_ANOMALY_THRESHOLD})`)
            
            if (entry.performanceAnomalies >= PERFORMANCE_ANOMALY_THRESHOLD) {
              proxiesToForceSwitch.push({ key, reason: '性能低下' })
            }
          } else {
            // 性能正常，重置所有异常计数
            const hadAnomalies = entry.performanceAnomalies > 0
            entry.performanceAnomalies = 0
            entry.zeroRequestCount = 0
            
            if (hadAnomalies) {
              console.log(`  [${entry.proxyIp}]: 过期时间 ${new Date(entry.expireAt).toLocaleTimeString()}, 请求次数 ${entry.requestCount} (新增${newRequests}次 ≥ ${PERFORMANCE_REQUEST_THRESHOLD}, 性能恢复，清除异常计数)`)
            } else {
              console.log(`  [${entry.proxyIp}]: 过期时间 ${new Date(entry.expireAt).toLocaleTimeString()}, 请求次数 ${entry.requestCount} (新增${newRequests}次)`)
            }
          }
        }
        
        // Keep only last 7 records for 3-minute cleanup check (6 intervals + 1 current)
        if (history.length > 7) {
          history.splice(0, history.length - 7)
        }
      }
    })
    
    // Force switch poor performance proxies
    for (const { key, reason } of proxiesToForceSwitch) {
      forceSwitchProxy(key, reason).catch(err => {
        console.log('============================================================')
        console.warn(`强制切换失败: ${err?.message || err}`)
        console.log('============================================================\n')
      })
    }
    
    // Check for inactive proxies (no request count change in last 6 intervals = 3 minutes)
    cleanupInactiveProxies()
  }
}

function getKeyByProxy(proxyUrl) {
  for (const [key, entry] of sessionProxyMap.entries()) {
    if (entry.url === proxyUrl) {
      return key
    }
  }
  return null
}

// Track request errors and determine if it should count as consecutive error
function trackRequestError(key, error, statusCode) {
  const entry = sessionProxyMap.get(key)
  if (!entry) return false
  
  // Only count 500 status codes and timeouts as consecutive errors
  const isConsecutiveError = statusCode === 500 || 
    (error && (error.name === 'AbortError' || error.message.includes('timeout') || error.message.includes('ETIMEDOUT')))
  
  if (isConsecutiveError) {
    entry.consecutiveErrors = (entry.consecutiveErrors || 0) + 1
    console.log('============================================================')
    console.log(`[${entry.proxyIp}] 连续错误计数: ${entry.consecutiveErrors}/${CONSECUTIVE_ERROR_THRESHOLD}`)
    console.log('============================================================\n')
    
    if (entry.consecutiveErrors >= CONSECUTIVE_ERROR_THRESHOLD) {
      console.log('============================================================')
      console.log(`[${entry.proxyIp}] 连续${CONSECUTIVE_ERROR_THRESHOLD}次错误，标记为问题代理，强制切换`)
      console.log('============================================================\n')
      return true // Need force switch
    }
  } else {
    // Reset consecutive errors for non-critical errors (429, 403, etc.)
    if (entry.consecutiveErrors > 0) {
      console.log('============================================================')
      console.log(`[${entry.proxyIp}] 非关键错误，清除连续错误计数`)
      console.log('============================================================\n')
      entry.consecutiveErrors = 0
    }
  }
  
  return false
}

// Force switch proxy due to consecutive errors or poor performance
async function forceSwitchProxy(key, reason) {
  const oldEntry = sessionProxyMap.get(key)
  if (!oldEntry) return null
  
  try {
    const { proxyUrl, safeExpireTs, proxyIp } = await acquireProxy()
    const newEntry = {
      url: proxyUrl,
      expireAt: safeExpireTs,
      proxyIp: proxyIp,
      requestCount: 0,
      lastUsed: Date.now(),
      consecutiveErrors: 0,
      performanceHistory: [],
      performanceAnomalies: 0,
      firstReportSkipped: false,
      zeroRequestCount: 0
    }
    
    sessionProxyMap.set(key, newEntry)
    sessionHistory.delete(key) // Reset history for new proxy
    
    console.log('============================================================')
    console.log(`[${oldEntry.proxyIp}] 强制切换 (原因: ${reason}) → [${proxyIp}]`)
    console.log('============================================================\n')
    
    return newEntry
  } catch (error) {
    console.log('============================================================')
    console.warn(`强制切换失败: ${error?.message || error}`)
    console.log('============================================================\n')
    return null
  }
}

function cleanupInactiveProxies() {
  const toRemove = []
  
  for (const [key, history] of sessionHistory.entries()) {
    if (history.length >= 6) {
      const latest = history[history.length - 1]
      const sixIntervalsAgo = history[history.length - 6]
      
      // If request count hasn't changed in last 6 intervals (3 minutes)
      if (latest.requestCount === sixIntervalsAgo.requestCount) {
        const entry = sessionProxyMap.get(key)
        if (entry) {
          console.log('============================================================')
          console.log(`  [${entry.proxyIp}] 检测到3分钟无活动，释放代理 (窗口可能已关闭)`)
          console.log('============================================================\n')
          toRemove.push(key)
        }
      }
    }
  }
  
  toRemove.forEach(key => {
    sessionProxyMap.delete(key)
    sessionHistory.delete(key)
  })
}

// Removed logRequest function - logging is now handled directly in onProxyRes

// Background proxy refresh and status scheduler
function startProxyRefreshScheduler() {
  if (!config.enableProxy) {
    return // No need for background refresh if proxy is disabled
  }
  
  const refreshIntervalMs = (config.upstream?.refreshBeforeExpirySec || 10) * 1000
  const checkIntervalMs = Math.min(refreshIntervalMs, 30000) // Check every 30s or refresh interval, whichever is smaller
  
  // Status reporting every 30s
  setInterval(() => {
    logProxyUsage(true)
  }, 30000)
  
  setInterval(async () => {
    const now = Date.now()
    const entries = Array.from(sessionProxyMap.entries())
    
    for (const [key, entry] of entries) {
      if (now >= entry.expireAt - 5000) { // Refresh 5 seconds before expiry
        try {
          await ensureProxyFresh(key, true)
        } catch (error) {
          console.log('============================================================')
          console.warn(`[${entry.proxyIp}] 后台刷新失败: ${error?.message || error}`)
          console.log('============================================================\n')
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
    const useProxy = req.headers['x-use-proxy'] !== 'false' // default true unless explicitly false
    let entry = null
    let proxyUrl = null
    
    if (config.enableProxy && useProxy) {
      try {
        entry = await ensureProxyFresh(key, false)
        proxyUrl = entry?.url
        
        // Update request count and last used time
        if (entry) {
          entry.requestCount++
          entry.lastUsed = Date.now()
        }
      } catch (proxyError) {
        console.log('============================================================')
        console.warn(`代理获取失败，切换到直连: ${proxyError?.message || proxyError}`)
        console.log('============================================================\n')
        // Continue with proxyUrl = null for direct connection
      }
    } else if (!useProxy) {
      // Only log once per window when switching to direct mode
      if (sessionProxyMap.has(key)) {
        console.log('============================================================')
      console.log(`[${new Date().toLocaleTimeString()}] 窗口 ${key} 切换到直连模式`)
      console.log('============================================================\n')
        sessionProxyMap.delete(key)
        sessionHistory.delete(key)
      }
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
        const now = new Date().toLocaleTimeString()
        console.log('============================================================')
        
        let needForceSwitch = false
        if (config.enableProxy && entry) {
          console.warn(`[${now}][${entry.proxyIp}] 请求错误: ${err?.message || err}`)
          
          // Track error and check if force switch is needed
          const statusCode = err?.response?.status || (err?.code === 'ECONNABORTED' ? 500 : null)
          needForceSwitch = trackRequestError(key, err, statusCode)
        } else {
          console.warn(`[${now}] 直连请求错误: ${err?.message || err}`)
        }
        console.log('============================================================\n')
        
        // Force switch if consecutive errors threshold reached
        if (needForceSwitch) {
          forceSwitchProxy(key, '连续错误').then((newEntry) => {
            if (newEntry) {
              // Don't retry the failed request, just switch proxy for future requests
              res2.statusCode = 502
              res2.end('Bad Gateway: proxy switched due to consecutive errors')
            } else {
              res2.statusCode = 502
              res2.end('Bad Gateway: proxy switch failed')
            }
          })
          return
        }
        
        // Normal error retry (not consecutive error threshold)
        if (useProxy) {
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
            console.log('============================================================')
            console.warn(`[${now}] 代理重试失败，切换到直连`)
            console.log('============================================================\n')
            return createProxyMiddleware({ 
              target: TARGET, 
              changeOrigin: true, 
              secure: false, 
              logLevel: 'silent', 
              pathRewrite: { '^/grab': '' },
              headers: { 'Connection': 'keep-alive' }
            })(req2, res2, next)
          })
        } else {
          // Direct connection retry
          return createProxyMiddleware({ 
            target: TARGET, 
            changeOrigin: true, 
            secure: false, 
            logLevel: 'silent', 
            pathRewrite: { '^/grab': '' },
            headers: { 'Connection': 'keep-alive' }
          })(req2, res2, next)
        }
      },
      onProxyReq: (proxyReq, req, res) => {
        const now = new Date().toLocaleTimeString()
        
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
        
        // 实时日志 (仅代理模式)
        if (config.enableProxy && entry) {
          console.log('============================================================')
          console.log(`[${now}][${entry.proxyIp}] 发送请求: ${req.method} ${proxyReq.path}`)
          console.log('============================================================\n')
        }
        // 直连模式只统计不打印实时日志
        if (!entry) {
          directConnectionCount++
        }
      },
      onProxyRes: (proxyRes, req, res) => {
        // Debug logging for 500 error handling
        if (proxyRes.statusCode === 500) {
          console.log('============================================================')
          console.log(`[DEBUG] 检测到500状态码`)
          console.log(`[DEBUG] config.enableProxy: ${config.enableProxy}`)
          console.log(`[DEBUG] entry存在: ${!!entry}`)
          console.log(`[DEBUG] entry.proxyIp: ${entry?.proxyIp}`)
          console.log(`[DEBUG] key: ${key}`)
          console.log('============================================================\n')
        }
        
        // Handle 500 status codes as consecutive errors
        if (config.enableProxy && entry && proxyRes.statusCode === 500) {
          console.log('============================================================')
          console.log(`[${entry.proxyIp}] 开始处理500错误，调用trackRequestError`)
          console.log('============================================================\n')
          
          const needForceSwitch = trackRequestError(key, null, proxyRes.statusCode)
          if (needForceSwitch) {
            // Force switch proxy due to consecutive 500 errors
            forceSwitchProxy(key, '连续500错误').then((newEntry) => {
              console.log('============================================================')
              console.log(`[${entry.proxyIp}] 连续500错误达到阈值，已强制切换代理`)
              console.log('============================================================\n')
            }).catch(err => {
              console.log('============================================================')
              console.warn(`强制切换失败: ${err?.message || err}`)
              console.log('============================================================\n')
            })
          }
        }
        
        // Reset consecutive errors on successful response (status < 500)
        if (config.enableProxy && entry && proxyRes.statusCode < 500) {
          if (entry.consecutiveErrors > 0) {
            console.log('============================================================')
            console.log(`[${entry.proxyIp}] 成功响应 (${proxyRes.statusCode})，清除连续错误计数`)
            console.log('============================================================\n')
            entry.consecutiveErrors = 0
          }
        }
        
        // Real-time response logging
        if (config.enableProxy && entry) {
          const now = new Date().toLocaleTimeString()
          console.log('============================================================')
          console.log(`[${now}][${entry.proxyIp}] 响应状态: ${proxyRes.statusCode} ${req.method} ${req.url}`)
          
          let responseData = ''
          const chunks = []
          
          proxyRes.on('data', (chunk) => {
            chunks.push(chunk)
          })
          
          proxyRes.on('end', () => {
            try {
              responseData = Buffer.concat(chunks).toString()
              const jsonData = JSON.parse(responseData)
              // Log response data details
              if (jsonData && typeof jsonData === 'object') {
                const logData = JSON.stringify(jsonData).substring(0, 200)
                console.log(`[${now}][${entry.proxyIp}] 响应数据: ${logData}${JSON.stringify(jsonData).length > 200 ? '...' : ''}`)
              }
            } catch {
              // If not JSON, log raw response (first 100 chars)
              const logData = responseData.substring(0, 100)
              console.log(`[${now}][${entry.proxyIp}] 响应数据: ${logData}${responseData.length > 100 ? '...' : ''}`)
            }
            console.log('============================================================\n')
          })
        }
        // 直连模式不打印实时响应日志，仅在30s报告中显示统计
      }
    })(req, res, next)
  } catch (e) {
    const now = new Date().toLocaleTimeString()
    console.log('============================================================')
    console.warn(`[${now}] 代理中间件设置失败，切换到直连`)
    console.log('============================================================\n')
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

// Proxy control endpoint for frontend
app.get('/proxy-control', (req, res) => {
  res.json({
    enableProxy: config.enableProxy || false,
    currentSessions: sessionProxyMap.size,
    uptime: Math.floor((Date.now() - lastStatusTime) / 1000)
  })
})

app.post('/proxy-control', (req, res) => {
  const { enableProxy } = req.body || {}
  if (typeof enableProxy === 'boolean') {
    config.enableProxy = enableProxy
    console.log('============================================================')
    console.log(`[${new Date().toLocaleTimeString()}] 代理功能已${enableProxy ? '启用' : '禁用'}`)
    console.log('============================================================\n')
    if (!enableProxy) {
      // Clear all proxy sessions when disabled
      sessionProxyMap.clear()
      sessionHistory.clear()
    }
    res.json({ success: true, enableProxy: config.enableProxy })
  } else {
    res.status(400).json({ error: 'Invalid enableProxy value' })
  }
})

app.listen(PORT, () => {
  console.log('============================================================')
  console.log(`代理服务器启动: http://localhost:${PORT}`)
  console.log(`目标服务器: ${TARGET}`)
  console.log(`代理功能: ${config.enableProxy ? '已启用' : '已禁用 (直连模式)'}`)
  console.log(`健康检查: http://localhost:${PORT}/healthz`)
  console.log(`代理状态: http://localhost:${PORT}/proxy-status`)
  console.log('============================================================\n')
  
  // Initial proxy status
  logProxyUsage()
  
  // Start background proxy refresh scheduler
  startProxyRefreshScheduler()
})


