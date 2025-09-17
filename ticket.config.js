export default {
  // 服务端口
  serverPort: 5180,

  // 目标后端（/grab）
  grabTarget: 'https://ai-smart-subsidy-backend.digitalhainan.com.cn',

  // 每轮并发请求数（越大频率越高）
  concurrency: 5, // 建议 3~10

  // 每轮是否包含 1 个直连请求（其余走代理）
  useDirectPerWave: true,

  // 两轮之间的基础等待（毫秒，调大可明显降低频率）
  waveDelayMs: 400,

  // 每轮额外随机抖动等待（毫秒，避免过于规律；0 表示无抖动）
  waveDelayJitterMs: 50,

  // 单个 ticket 请求超时（毫秒）
  requestTimeoutMs: 8000,

  // 单次 /ticket/entry 调用的全局超时（毫秒）
  globalTimeoutMs: 20000,

  // 最多轮数（0 或负数表示不限制，直到触达全局超时）
  maxWaves: 0,

  // 代理获取
  upstream: {
    // 代理池接口（返回结构与 server.proxy.js 一致）
    // {"count":"2","status":"0","expire":"2025-09-17 14:44:35","list":[{"sever":"220.202.110.142","port":23829,"net_type":2}, ...]}
    providerUrl: 'https://sch.shanchendaili.com/api.html?action=get_ip&key=HU027700915310840704oqdi&time=1&count=10&type=json&only=0',

    // 上游代理协议：'http' | 'https' | 'socks5'
    proxyScheme: 'http',

    // 获取代理接口超时（毫秒）
    requestTimeoutMs: 8000,

    // https 代理是否严格校验证书
    rejectUnauthorized: false,
  },

  // 日志目录（按窗口 + 日期切分文件）
  logsDir: 'logs/tickets',

  // 非高峰期模拟：保留 1% 命中，其余改写为 null（用于压测并发稳定性）
  simulation: {
    enabled: false,
    hitKeepRate: 1,
  },
} 