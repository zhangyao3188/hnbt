// Test config with shorter expiry times for quick verification
export default {
  // Port for local express proxy server
  serverPort: 5179,

  // Target backend for /grab
  grabTarget: 'https://httpbin.org', // Use httpbin for testing

  // Upstream proxy acquisition and behavior
  upstream: {
    // Provider URL that returns one proxy IP per request
    providerUrl: 'https://sch.shanchendaili.com/api.html?action=get_ip&key=HU027700915310840704oqdi&time=1&count=1&type=json&only=0',

    // Scheme of the upstream proxy itself: 'http' or 'https'
    proxyScheme: 'http',

    // How many seconds before reported expire time to proactively refresh
    refreshBeforeExpirySec: 5, // Reduced for testing

    // Timeout for validation and proxy requests
    requestTimeoutMs: 15000, // Increased timeout

    // Whether to validate newly acquired proxy by sending a HEAD to target
    validateOnAcquire: false, // Disabled for testing since we may not have real proxies
  },
}
