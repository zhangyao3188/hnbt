import axios from 'axios'

let grabToken = ''

export function setGrabAuthToken(token) {
  grabToken = token || ''
}

const grab = axios.create({
  baseURL: '/grab',
  timeout: 15000,
  withCredentials: false,
})

grab.interceptors.request.use((config) => {
  config.headers = config.headers || {}
  if (!config.headers['Content-Type']) {
    config.headers['Content-Type'] = 'application/json'
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