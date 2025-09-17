export default {
  // Service port
  serverPort: 5181,

  // Target backend base URL
  grabTarget: 'https://ai-smart-subsidy-backend.digitalhainan.com.cn',

  // Per-quota concurrency for submit attempts (e.g., 5 means each quota sends 5 concurrent requests)
  perQuotaConcurrency: 5,

  // Whether to include one direct request per quota wave
  useDirectPerQuotaWave: true,

  // Delay between waves when no success (ms)
  waveDelayMs: 50,

  // Global timeout for a single /submit/apply request (ms)
  globalTimeoutMs: 25000,

  // Maximum number of waves (0 or negative => unlimited until timeout)
  maxWaves: 0,

  // Proxy acquisition settings
  upstream: {
    // Provider URL returning proxies. Same structure as ticket service provider.
    providerUrl: 'https://sch.shanchendaili.com/api.html?action=get_ip&key=HU027700915310840704oqdi&time=1&count=10&type=json&only=0',

    // Proxy scheme: 'http', 'https', or 'socks5'
    proxyScheme: 'http',

    // Timeout for provider requests (ms)
    requestTimeoutMs: 8000,

    // TLS validation for https proxies
    rejectUnauthorized: false,
  },

  // Logging directory (will be created if missing)
  logsDir: 'logs/submit',
} 