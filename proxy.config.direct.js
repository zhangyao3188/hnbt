// Config example: Direct connection mode (proxy disabled)
export default {
  // Port for local express proxy server
  serverPort: 5179,

  // Target backend for /grab
  grabTarget: 'https://ai-smart-subsidy-backend.digitalhainan.com.cn',

  // Whether to enable proxy IP usage (true: use proxy, false: direct connection)
  enableProxy: false, // 设置为 false 使用直连

  // Upstream proxy acquisition and behavior (ignored when enableProxy is false)
  upstream: {
    providerUrl: 'https://sch.shanchendaili.com/api.html?action=get_ip&key=HU027700915310840704oqdi&time=1&count=1&type=json&only=0',
    proxyScheme: 'http',
    refreshBeforeExpirySec: 10,
    requestTimeoutMs: 10000,
    validateOnAcquire: true,
  },
}
