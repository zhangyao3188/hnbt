import axios from 'axios'

let grabToken = ''
let grabUid = ''

export function setGrabAuthToken(token) {
  grabToken = token || ''
}

export function setGrabUid(uid) {
  grabUid = uid || ''
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
  // Fixed platform header
  config.headers['AppPlatform'] = 'H5'
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