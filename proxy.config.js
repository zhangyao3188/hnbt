// Config for local proxy server and upstream proxy acquisition
export default {
  // Enable/disable proxy functionality (can be toggled at runtime)
  enableProxy: true,

  // Port for local express proxy server
  serverPort: 5179,

  // Target backend for /grab
  grabTarget: 'https://ai-smart-subsidy-backend.digitalhainan.com.cn',

  // Whether to enable proxy IP usage (true: use proxy, false: direct connection)
  enableProxy: true,

  // Upstream proxy acquisition and behavior
  upstream: {
    // Provider URL that returns one proxy IP per request
    // Example response:
    // {"count":"1","status":"0","expire":"2025-09-12 23:07:03","list":[{"sever":"112.85.129.251","port":37474,"net_type":2}]}
    providerUrl: 'https://sch.shanchendaili.com/api.html?action=get_ip&key=HU027700915310840704oqdi&time=30&count=1&type=json&only=1',

    // Scheme of the upstream proxy itself: 'http', 'https', or 'socks5'
    // 使用 SOCKS5 代理协议（通常更稳定）
    proxyScheme: 'socks5',

    // How many seconds before reported expire time to proactively refresh
    refreshBeforeExpirySec: 10,

    // Timeout for validation and proxy requests
    requestTimeoutMs: 10000,

    // Whether to validate newly acquired proxy by sending a test request to target
    // Set to false if target server doesn't support HEAD requests or causes 405 errors
    validateOnAcquire: false,
  },

  // Proxy quality monitoring settings
  qualityMonitoring: {
    // 连续错误次数阈值 (HTTP 500 + 超时)
    consecutiveErrorThreshold: 5,
    
    // 30s内最低请求次数阈值 (低于此值视为性能差)
    performanceRequestThreshold: 15,
    
    // 连续性能异常次数阈值
    performanceAnomalyThreshold: 2,
  },
}


