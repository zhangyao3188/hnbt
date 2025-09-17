import axios from 'axios'

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
    if (!windowProxyKey) {
      windowProxyKey = Math.random().toString(36).slice(2)
    }
    return windowProxyKey
  }
}

const submit = axios.create({
  baseURL: '/submit',
  timeout: 20000,
  withCredentials: false,
})

submit.interceptors.request.use((config) => {
  config.headers = config.headers || {}
  if (!config.headers['Content-Type']) {
    config.headers['Content-Type'] = 'application/json'
  }
  config.headers['AppPlatform'] = 'H5'
  config.headers['x-proxy-key'] = getWindowProxyKey()
  try {
    const grabToken = localStorage.getItem('grabToken') || ''
    const accId = localStorage.getItem('accId') || ''
    if (grabToken) config.headers['authorization'] = `Bearer ${grabToken}`
    if (accId) config.headers['uid'] = accId
  } catch {}
  return config
})

submit.interceptors.response.use(
  (resp) => resp.data,
  (error) => {
    const message = error?.response?.data?.message || error.message || 'Network Error'
    return Promise.reject(new Error(message))
  }
)

export default submit 