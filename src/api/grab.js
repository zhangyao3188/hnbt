import axios from 'axios'

let grabToken = ''
let grabUid = ''

// Per-window proxy key
let windowProxyKey = ''
function getWindowProxyKey() {
  try {
    const KEY = 'proxyKey'
    const exist = sessionStorage.getItem(KEY)
    if (exist) return exist
    const random = Math.random().toString(36).slice(2) + Date.now().toString(36)
    sessionStorage.setItem(KEY, random)
    return random
  } catch {
    // Fallback if sessionStorage unavailable
    if (!windowProxyKey) {
      windowProxyKey = Math.random().toString(36).slice(2)
    }
    return windowProxyKey
  }
}

export function setGrabAuthToken(token) {
  grabToken = token || ''
}

export function setGrabUid(uid) {
  grabUid = uid || ''
}

const grab = axios.create({
  baseURL: '/grab',
  timeout: 60000,
  withCredentials: false,
})

grab.interceptors.request.use((config) => {
  config.headers = config.headers || {}
  if (!config.headers['Content-Type']) {
    config.headers['Content-Type'] = 'application/json'
  }
  // Fixed platform header
  config.headers['AppPlatform'] = 'H5'
  // Per-window proxy routing header
  config.headers['x-proxy-key'] = getWindowProxyKey()
  if (grabUid) {
    config.headers['uid'] = grabUid
  }
  if (grabToken) {
    config.headers['authorization'] = `Bearer ${grabToken}`
  }
  return config
})

grab.interceptors.response.use(
  (resp) => resp.data,
  (error) => {
    const message = error?.response?.data?.message || error.message || 'Network Error'
    return Promise.reject(new Error(message))
  }
)

export default grab 