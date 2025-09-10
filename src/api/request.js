import axios from 'axios'

let authToken = ''

export function setAuthToken(token) {
  authToken = token || ''
}

const request = axios.create({
  baseURL: '/api/noauth',
  timeout: 15000,
  withCredentials: false,
})

request.interceptors.request.use((config) => {
  config.headers = config.headers || {}
  if (!config.headers['Content-Type']) {
    config.headers['Content-Type'] = 'application/json'
  }
  if (authToken) {
    config.headers['authorization'] = `Bearer ${authToken}`
  }
  return config
})

request.interceptors.response.use(
  (resp) => resp.data,
  (error) => {
    const message = error?.response?.data?.message || error.message || 'Network Error'
    return Promise.reject(new Error(message))
  }
)

export default request 