// Quick proxy validator: fetch proxy from provider and check IP via ip138
import fetch from 'node-fetch'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { HttpProxyAgent } from 'http-proxy-agent'
import config from './proxy.config.js'

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const headers = Object.assign({ 'user-agent': 'Mozilla/5.0 (proxy-checker)' }, options.headers || {})
  return fetch(url, { ...options, headers, signal: ac.signal })
    .finally(() => clearTimeout(timer))
}

function parseProviderResponse(json) {
  const item = Array.isArray(json?.list) ? json.list[0] : null
  if (!item) throw new Error('provider empty list')
  const host = item.sever || item.server || item.ip || ''
  const port = item.port
  if (!host || !port) throw new Error('provider missing host/port')
  const scheme = (config.upstream?.proxyScheme || 'http').toLowerCase()
  const proxyUrl = `${scheme}://${host}:${port}`
  return { proxyUrl, meta: item }
}

async function getProxyUrl() {
  const url = process.env.PROXY_PROVIDER_URL || config.upstream?.providerUrl
  if (!url) throw new Error('providerUrl not configured')
  console.log('[test] fetching provider:', url)
  const res = await fetchWithTimeout(url, {}, config.upstream?.requestTimeoutMs || 10000)
  const json = await res.json()
  console.log('[test] provider response:', JSON.stringify(json))
  if (String(json?.status || '') !== '0') throw new Error(`provider status ${json?.status}`)
  return parseProviderResponse(json)
}

function extractIp(html) {
  // try title first
  const t = /<title>[^<]*?(\d{1,3}(?:\.\d{1,3}){3})[^<]*<\/title>/i.exec(html)
  if (t && t[1]) return t[1]
  // fallback any IPv4 in body
  const b = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(html)
  return b ? b[1] : ''
}

async function main() {
  console.log('[test] start')
  const { proxyUrl, meta } = await getProxyUrl()
  console.log('[test] using proxy:', proxyUrl, '| meta=', JSON.stringify(meta))

  // Step 1: HTTP test (no CONNECT required)
  const httpUrl = 'http://httpbin.org/ip'
  try {
    const httpAgent = new HttpProxyAgent(proxyUrl)
    console.log('[test] requesting', httpUrl)
    const r1 = await fetchWithTimeout(httpUrl, { agent: httpAgent }, 10000)
    const j1 = await r1.json().catch(() => ({}))
    console.log('[test] httpbin ip:', j1?.origin || JSON.stringify(j1))
  } catch (e) {
    console.error('[test] HTTP test failed:', e?.message || e)
  }

  // Step 2: HTTPS test with ip138 (requires CONNECT)
  const httpsUrl = 'https://2025.ip138.com/'
  try {
    const httpsAgent = new HttpsProxyAgent(proxyUrl)
    console.log('[test] requesting', httpsUrl)
    const r2 = await fetchWithTimeout(httpsUrl, { agent: httpsAgent }, 15000)
    console.log('[test] ip138 status:', r2.status)
    const html = await r2.text()
    const ip = extractIp(html)
    console.log('[test] ip138 detected IP:', ip || '(not found)')
  } catch (e) {
    console.error('[test] HTTPS test failed:', e?.message || e)
    if (/CONNECT response/i.test(String(e?.message))) {
      console.error('[test] hint: 当前代理很可能不支持 HTTPS CONNECT 隧道，请更换支持 HTTPS 的代理或将 proxyScheme 改为 https/socks。')
    }
  }
}

main().catch((e) => {
  console.error('[test] failed:', e?.message || e)
  process.exitCode = 1
})


