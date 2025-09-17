<script setup>
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import request, { setAuthToken } from './api/request'
import grab, { setGrabAuthToken, setGrabUid, setUseProxy, toggleUseProxy } from './api/grab'
import successSoundUrl from '../assets/music.mp3'
import ticketClient from './api/ticket'
import submitClient from './api/submit'

// Server酱推送配置（页面可填写，默认读取本地缓存）
const sctKey = ref(localStorage.getItem('sctKey') || '')
const sctLocked = ref(localStorage.getItem('sctKeyLocked') === '1')
const SCT_SEND_URL = computed(() => (sctKey.value ? `https://sctapi.ftqq.com/${sctKey.value}.send` : ''))
const sctDisplay = computed(() => sctKey.value ? `${sctKey.value.slice(0,4)}...${sctKey.value.slice(-4)}` : '未设置')

function saveSctKey() {
  sctKey.value = (sctKey.value || '').trim()
  localStorage.setItem('sctKey', sctKey.value)
  sctLocked.value = true
  localStorage.setItem('sctKeyLocked', '1')
  addLog('已保存并锁定推送Key')
}
function unlockSctKey() {
  sctLocked.value = false
  localStorage.removeItem('sctKeyLocked')
  addLog('已解锁推送Key，可编辑')
}

async function sendTestPush() {
  if (!SCT_SEND_URL.value) {
    addLog('未配置Server酱推送Key，无法测试推送')
    return
  }
  try {
    const payload = {
      title: '测试推送',
      desp: '这是测试推送功能的内容',
      short: '测试推送',
      noip: 1,
      channel: '9'
    }
    const res = await fetch(SCT_SEND_URL.value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify(payload)
    })
    const json = await res.json().catch(() => ({}))
    addLog(`测试推送结果：${json?.message || json?.msg || '已请求推送'}`)
  } catch (e) {
    addLog(`测试推送失败：${e.message || e}`)
  }
}

async function sendPushOnSuccess({ name, phone, quota, time, uniqueId, isDuplicate = false }) {
  if (!SCT_SEND_URL.value) {
    addLog('未配置Server酱推送Key，已跳过推送')
    return
  }
  try {
    const titlePrefix = isDuplicate ? '重复提交' : '抢购成功'
    const title = `${titlePrefix}-${name || '用户'}-${quota}`.slice(0, 32)
    const lines = [
      `账号：${phone || ''}`,
      `姓名：${name || ''}`,
      `档位：${quota || ''}`,
      `时间：${time || new Date().toLocaleString()}`,
      `uniqueId：${uniqueId || ''}`,
      `状态：${isDuplicate ? '重复提交（已在其他渠道成功）' : '首次提交成功'}`
    ]
    const desp = lines.join('\n')
    const shortText = `${isDuplicate ? '重复' : '成功'} ${quota} | ${name || ''} ${phone || ''}`.slice(0, 64)
    const payload = { title, desp, short: shortText, noip: 1, channel: '9' }
    const res = await fetch(SCT_SEND_URL.value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify(payload)
    })
    const json = await res.json().catch(() => ({}))
    addLog(`推送结果：${json?.message || json?.msg || '已请求推送'}`)
  } catch (e) {
    addLog(`推送失败：${e.message || e}`)
  }
}

// ===== Auth state =====
const phone = ref('')
const smsCode = ref('')
const isLoggingIn = ref(false)
const user = ref(null) // { id, phone(masked), name, token, accId? }

// ===== Multi-accounts =====
const accounts = ref([]) // [{ id, name, phone, token, accId, grabToken, ticketSNO, uniqueId, createdAt }]
const activeAccountId = ref('')
const accountsVisible = ref(false)

function persistAccounts() {
  try {
    localStorage.setItem('accounts', JSON.stringify(accounts.value || []))
    localStorage.setItem('activeAccountId', activeAccountId.value || '')
  } catch {}
}

function maskPhone(p) {
  return (p || '').replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
}

function upsertAccount(partial) {
  const id = partial.id || partial.phone || (partial.token ? partial.token.slice(-8) : Math.random().toString(36).slice(2))
  const idx = accounts.value.findIndex(a => a.id === id || (partial.phone && a.phone === partial.phone) || (partial.token && a.token === partial.token))
  const normalizeQuotas = (arr) => {
    try {
      const set = new Set((arr || []).map(v => Number(v)).filter(v => !Number.isNaN(v)))
      return Array.from(set)
    } catch { return [] }
  }
  const base = {
    id,
    name: partial.name || '用户',
    phone: partial.phone || '',
    token: partial.token || '',
    accId: partial.accId || '',
    grabToken: partial.grabToken || '',
    ticketSNO: partial.ticketSNO || '',
    uniqueId: partial.uniqueId || '',
    quotas: normalizeQuotas(partial.quotas),
    createdAt: partial.createdAt || Date.now()
  }
  if (idx >= 0) {
    accounts.value[idx] = { ...accounts.value[idx], ...base }
    persistAccounts()
    return accounts.value[idx]
  } else {
    accounts.value.push(base)
    persistAccounts()
    return base
  }
}

function applyActiveAccount(acc) {
  if (!acc) return
  // sync runtime user
  user.value = {
    id: acc.id,
    phone: maskPhone(acc.phone),
    name: acc.name || '用户',
    token: acc.token || '',
    accId: acc.accId || ''
  }
  // sync tokens to API modules
  setAuthToken(acc.token || '')
  setGrabAuthToken(acc.grabToken || '')
  if (acc.accId) setGrabUid(acc.accId)
  // sync runtime uniqueId
  uniqueId.value = acc.uniqueId || ''
  // sync saved quotas to runtime selection
  selectedQuotas.value = Array.isArray(acc.quotas) ? [...acc.quotas] : []
  selectedQuota.value = selectedQuotas.value[0] || null
  // keep legacy single-account storage for backward compatibility and导出
  localStorage.setItem('auth', JSON.stringify({ name: acc.name || '用户', token: acc.token || '', phone: acc.phone || '' }))
  if (acc.accId) localStorage.setItem('accId', acc.accId)
  if (acc.ticketSNO) localStorage.setItem('ticketSNO', acc.ticketSNO)
  if (acc.grabToken) localStorage.setItem('grabToken', acc.grabToken)
  if (acc.uniqueId) localStorage.setItem('uniqueId', acc.uniqueId)
}

function switchAccount(id) {
  const acc = accounts.value.find(a => a.id === id)
  if (!acc) return
  activeAccountId.value = acc.id
  persistAccounts()
  applyActiveAccount(acc)
  addLog(`已切换账号：${acc.name || ''} ${maskPhone(acc.phone)}`)
  // refresh grab token if missing and fetch uniqueId for this account
  refreshGrabAuthAndUniqueId()
}

function deleteAccount(id) {
  const idx = accounts.value.findIndex(a => a.id === id)
  if (idx < 0) return
  const removed = accounts.value.splice(idx, 1)[0]
  addLog(`已删除账号：${removed?.name || ''} ${maskPhone(removed?.phone)}`)
  if (activeAccountId.value === id) {
    const next = accounts.value[0]
    if (next) {
      activeAccountId.value = next.id
      applyActiveAccount(next)
    } else {
      // no accounts left → clear runtime tokens
      onLogout()
      activeAccountId.value = ''
    }
  }
  persistAccounts()
}

function openAccounts() { accountsVisible.value = true }
function closeAccounts() { accountsVisible.value = false }

// Refresh grab token (if missing) and uniqueId for current active account, then persist
async function refreshGrabAuthAndUniqueId() {
  try {
    // if not have grabToken, try exchange
    if (!localStorage.getItem('grabToken') && user.value?.token) {
      await exchangeGrabToken()
    }
    await fetchUniqueId()
    // write back to active account
    const idx = accounts.value.findIndex(a => a.id === activeAccountId.value)
    if (idx >= 0) {
      accounts.value[idx] = {
        ...accounts.value[idx],
        grabToken: localStorage.getItem('grabToken') || accounts.value[idx].grabToken || '',
        ticketSNO: localStorage.getItem('ticketSNO') || accounts.value[idx].ticketSNO || '',
        uniqueId: uniqueId.value || accounts.value[idx].uniqueId || ''
      }
      persistAccounts()
    }
  } catch (e) {
    addLog(`刷新uniqueId失败：${e?.message || e}`)
  }
}

// Captcha & SMS state (modal flow)
const captchaImage = ref('') // data URL
const imageKey = ref('')
const imageCode = ref('')
const smsSending = ref(false)
const captchaVisible = ref(false)

// Export/Import modal state
const importVisible = ref(false)
const importText = ref('')
const importFileName = ref('')
const importMode = ref('paste') // 'paste' | 'file'

// Purchase related state
const selectedQuota = ref(null) // 800 or 300
const selectedQuotas = ref([]) // multi-select: [1500,800,300]
const quotaVisible = ref(false)
const quotaTemp = ref(800)
const quotaTempMulti = ref([])
const perQuotaConcurrency = ref(5)
const uniqueId = ref('')
const isPurchasing = ref(false)
const aborted = ref(false)

// Proxy control state
const useProxyForWindow = ref(true)

function initProxyState() {
  try {
    const stored = sessionStorage.getItem('useProxy')
    useProxyForWindow.value = stored !== 'false'
  } catch {
    useProxyForWindow.value = true
  }
}

function onToggleProxy() {
  const newValue = toggleUseProxy()
  useProxyForWindow.value = newValue
  addLog(`代理设置：${newValue ? '启用代理IP' : '使用直连IP'}`)
}

// Logs
const logs = ref([])

function addLog(message) {
  const timestamp = new Date().toLocaleTimeString()
  logs.value.unshift(`[${timestamp}] ${message}`)
  if (logs.value.length > 100) {
    logs.value.pop()
  }
}

function clearLogs() {
  logs.value = []
}

// ===== Success sound =====
let successAudio = null

function prepareSuccessAudio() {
  try {
    if (!successAudio) {
      successAudio = new Audio(successSoundUrl)
      successAudio.preload = 'auto'
    }
  } catch {}
}

function unlockSuccessAudio() {
  try {
    prepareSuccessAudio()
    if (!successAudio || successAudio._unlocked) return
    successAudio.muted = true
    const p = successAudio.play()
    if (p && typeof p.then === 'function') {
      p.then(() => {
        successAudio.pause()
        successAudio.currentTime = 0
        successAudio.muted = false
        successAudio._unlocked = true
      }).catch(() => {})
    }
  } catch {}
}

async function playSuccessAudioOnce() {
  try {
    prepareSuccessAudio()
    if (!successAudio) return
    successAudio.currentTime = 0
    await successAudio.play().catch(() => {})
  } catch {}
}

async function onExportUser() {
  try {
    const authRaw = localStorage.getItem('auth')
    const auth = authRaw ? JSON.parse(authRaw) : {}
    const data = {
      name: auth?.name || user.value?.name || '',
      phone: auth?.phone || '',
      token: auth?.token || user.value?.token || '',
      accId: localStorage.getItem('accId') || '',
      ticketSNO: localStorage.getItem('ticketSNO') || '',
      grabToken: localStorage.getItem('grabToken') || '',
      uniqueId: localStorage.getItem('uniqueId') || '',
      quotas: user.value?.quotas || [] // Include quotas in export
    }
    const text = JSON.stringify(data, null, 2)
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    addLog('用户信息已复制到剪贴板')
  } catch (e) {
    addLog(`导出失败：${e.message || e}`)
  }
}

async function onExportAllAccounts() {
  try {
    const payload = {
      exportedAt: new Date().toISOString(),
      accounts: (accounts.value || []).map(a => ({
        id: a.id,
        name: a.name || '用户',
        phone: a.phone || '',
        token: a.token || '',
        accId: a.accId || '',
        ticketSNO: a.ticketSNO || '',
        grabToken: a.grabToken || '',
        uniqueId: a.uniqueId || '',
        quotas: Array.isArray(a.quotas) ? a.quotas : [],
        createdAt: a.createdAt || Date.now()
      }))
    }
    const text = JSON.stringify(payload, null, 2)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `accounts-${new Date().toISOString().slice(0,10)}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    addLog('账号列表已导出为TXT')
  } catch (e) {
    addLog(`导出全部账号失败：${e.message || e}`)
  }
}

function onPickImportFile() {
  try {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.txt,.json,application/json,text/plain'
    input.onchange = async (e) => {
      const file = e.target.files && e.target.files[0]
      if (!file) return
      importMode.value = 'file'
      importFileName.value = file.name
      const text = await file.text()
      importText.value = text
      importVisible.value = true
    }
    input.click()
  } catch (e) {
    addLog(`选择文件失败：${e.message || e}`)
  }
}

async function onConfirmImportFileOverwrite() {
  try {
    const obj = JSON.parse(importText.value || '{}')
    if (Array.isArray(obj.accounts)) {
      let countUpsert = 0
      for (const item of obj.accounts) {
        const acc = upsertAccount({
          name: item.name || '用户',
          token: item.token || '',
          phone: item.phone || '',
          accId: item.accId || '',
          ticketSNO: item.ticketSNO || '',
          grabToken: item.grabToken || '',
          uniqueId: item.uniqueId || '',
          quotas: Array.isArray(item.quotas) ? item.quotas : [],
          id: item.id || undefined,
          createdAt: item.createdAt || undefined
        })
        countUpsert += 1
      }
      persistAccounts()
      // 保持当前活动账号不变，如不存在则选择第一个
      if (!activeAccountId.value && accounts.value.length > 0) {
        activeAccountId.value = accounts.value[0].id
      }
      const activeAcc = accounts.value.find(a => a.id === activeAccountId.value)
      if (activeAcc) applyActiveAccount(activeAcc)
      importVisible.value = false
      addLog(`批量导入完成：共${countUpsert}个账号（已覆盖同ID/同手机号/同token）`)
    } else {
      // 兼容单账号导入
      await onConfirmImport()
    }
  } catch (e) {
    addLog(`导入失败：${e.message || e}`)
  }
}

function openImportUser() {
  importMode.value = 'paste'
  importText.value = ''
  importVisible.value = true
}

async function onConfirmImport() {
  try {
    const obj = JSON.parse(importText.value || '{}')
    const name = obj.name || user.value?.name || '用户'
    const token = obj.token || ''
    const phoneRaw = obj.phone || ''
    const accId = obj.accId || ''
    const ticketSNO = obj.ticketSNO || ''
    const grabToken = obj.grabToken || ''
    const uniq = obj.uniqueId || ''
    const quotas = Array.isArray(obj.quotas) ? obj.quotas : []

    if (token) {
      const acc = upsertAccount({ name, token, phone: phoneRaw, accId, ticketSNO, grabToken, uniqueId: String(uniq || ''), quotas })
      activeAccountId.value = acc.id
      persistAccounts()
      applyActiveAccount(acc)
      await refreshGrabAuthAndUniqueId()
    }

    importVisible.value = false
    addLog('导入完成：已加入账号列表，并切换为当前账号')
  } catch (e) {
    addLog(`导入失败：${e.message || e}`)
  }
}

// ===== Captcha & SMS =====
async function fetchCaptcha() {
  try {
    const res = await request.get('/valid/code/image', {})
    const img64 = res?.body?.image64
    const key = res?.body?.key
    if (img64 && key) {
      captchaImage.value = `data:image/png;base64,${img64}`
      imageKey.value = key
      imageCode.value = ''
      addLog(`图形码已获取/刷新${res?.message ? '：'+res.message : ''}`)
    } else {
      throw new Error('响应缺少图形码数据')
    }
  } catch (e) {
    addLog(`获取图形码失败：${e.message || e}`)
  }
}

async function onClickSendSms() {
  if (!/^\d{11}$/.test(phone.value)) {
    addLog('请输入11位手机号')
    return
  }
  captchaVisible.value = true
  await fetchCaptcha()
}

async function confirmCaptchaAndSendSms() {
  if (!imageKey.value) {
    addLog('图形码未就绪，请重试')
    return
  }
  if (!imageCode.value) {
    addLog('请输入图形验证码')
    return
  }
  try {
    smsSending.value = true
    const payload = {
      body: {
        imageCode: imageCode.value,
        imageKey: imageKey.value,
        phoneNo: phone.value,
        areaCode: '86',
        scene: '小程序端登录'
      }
    }
    const res = await request.post('/valid/code/sms/scene', payload)
    const msg = res?.header?.errorMsg || res?.message || '短信发送结果未知'
    addLog(`短信发送：${msg}`)
    captchaVisible.value = false
  } catch (e) {
    addLog(`短信发送失败：${e.message || e}`)
  } finally {
    smsSending.value = false
  }
}

// ===== SSO: exchange token for grab API =====
async function exchangeGrabToken() {
  try {
    const res = await request.post('/natural/person/sso/authCode', { body: { ssoType: 'ticketSNO-person' } })
    const ticketSNO = res?.body?.ticketSNO
    if (!ticketSNO) throw new Error('未返回 ticketSNO')
    localStorage.setItem('ticketSNO', ticketSNO)
    addLog(`已获取 ticketSNO${res?.message ? '：'+res.message : ''}`)

    // exchange to final grab token
    let finalToken = ''
    try {
      const r1 = await grab.post('/ai-smart-subsidy-approval/api/oauth2/code2Token', ticketSNO)
      finalToken = r1?.data || ''
      if (r1?.message) addLog(`code2Token 回应：${r1.message}`)
    } catch (e) {}
    if (!finalToken) {
      try {
        const r2 = await grab.post('/ai-smart-subsidy-approval/api/oauth2/code2Token', { ticketSNO })
        finalToken = r2?.data || ''
        if (r2?.message) addLog(`code2Token 回应：${r2.message}`)
      } catch (e) {}
    }
    if (!finalToken) {
      try {
        const r3 = await grab.post('/ai-smart-subsidy-approval/api/oauth2/code2Token', { code: ticketSNO })
        finalToken = r3?.data || ''
        if (r3?.message) addLog(`code2Token 回应：${r3.message}`)
      } catch (e) {}
    }

    if (!finalToken) throw new Error('未返回抢购token')
    setGrabAuthToken(finalToken)
    localStorage.setItem('grabToken', finalToken)
    addLog('已换取抢购系统token')
  } catch (e) {
    addLog(`换取抢购系统token失败：${e.message || e}`)
  }
}

// ===== Auth Login/Restore =====
async function onLogin() {
  if (!/^\d{11}$/.test(phone.value)) {
    addLog('请输入11位手机号')
    return
  }
  if (!smsCode.value) {
    addLog('请输入短信验证码')
    return
  }
  try {
    isLoggingIn.value = true
    const payload = {
      body: {
        deviceId: '',
        areaCode: '86',
        phone: phone.value,
        validCode: smsCode.value
      }
    }
    const res = await request.post('/natural/person/login/phone', payload)
    const name = res?.body?.name || '用户'
    const token = res?.body?.extend?.token || ''
    const accId = res?.body?.accId || ''
    if (!token) {
      throw new Error('登录返回缺少token')
    }
    const acc = upsertAccount({ name, token, phone: phone.value, accId })
    activeAccountId.value = acc.id
    persistAccounts()
    applyActiveAccount(acc)
    addLog(`登录成功，欢迎：${name}${res?.message ? '：'+res.message : ''}`)
    // exchange second-system token and get uniqueId
    await exchangeGrabToken()
    await fetchUniqueId()
    // persist latest grabToken/uniqueId back to account
    const idx = accounts.value.findIndex(a => a.id === activeAccountId.value)
    if (idx >= 0) {
      accounts.value[idx] = {
        ...accounts.value[idx],
        grabToken: localStorage.getItem('grabToken') || accounts.value[idx].grabToken || '',
        ticketSNO: localStorage.getItem('ticketSNO') || accounts.value[idx].ticketSNO || '',
        uniqueId: uniqueId.value || accounts.value[idx].uniqueId || ''
      }
      persistAccounts()
    }
  } catch (e) {
    addLog(`登录失败：${e.message || e}`)
  } finally {
    isLoggingIn.value = false
  }
}

function onLogout() {
  user.value = null
  selectedQuota.value = null
  setAuthToken('')
  setGrabAuthToken('')
  setGrabUid('')
  uniqueId.value = ''
  localStorage.removeItem('auth')
  localStorage.removeItem('ticketSNO')
  localStorage.removeItem('grabToken')
  localStorage.removeItem('uniqueId')
  localStorage.removeItem('accId')
  addLog('已退出登录')
}



// ===== Grab API helpers =====
async function fetchUniqueId() {
  try {
    const res = await grab.post('/ai-smart-subsidy-approval/api/apply/getApplyOverView', {})
    const id = res?.data?.uniqueId
    if (id) {
      uniqueId.value = String(id)
      localStorage.setItem('uniqueId', uniqueId.value)
      addLog(`获取uniqueId成功：${uniqueId.value}${res?.message ? '：'+res.message : ''}`)
    } else {
      throw new Error('未返回uniqueId')
    }
  } catch (e) {
    addLog(`获取uniqueId失败：${e.message || e}`)
  }
}

async function ensureUniqueId() {
  if (!uniqueId.value) {
    await fetchUniqueId()
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function getPositionsWithRetry() {
  let attempts = 0
  addLog(`🔍 开始获取档位信息，目标补贴：${selectedQuota.value}`)
  
  while (true) {
    if (aborted.value) throw new Error('已停止')
    attempts++
    try {
      const res = await grab.post('/ai-smart-subsidy-approval/api/apply/getApplySubsidyPositionList')
      const list = res?.data?.tourismSubsidyPositions || []
      const match = list.find(x => Number(x.subsidyAmount) === Number(selectedQuota.value))
      const foodList = res?.data?.foodSubsidyPositions || []
      let foodId = null
      
      if (Array.isArray(foodList) && foodList.length > 0) {
        const maxFood = foodList.reduce((a, b) => Number(a.subsidyAmount) >= Number(b.subsidyAmount) ? a : b)
        foodId = maxFood?.id ?? null
        addLog(`🍽️ 餐饮档位选择：id=${foodId}，补贴=${maxFood?.subsidyAmount}${res?.message ? '：'+res.message : ''}`)
      }
      
      if (match) {
        addLog(`✅ 旅游档位匹配成功！id=${match.id}，补贴=${match.subsidyAmount}${res?.message ? '：'+res.message : ''}`)
        return { tourismId: match.id, foodId }
      }
      
      if (attempts % 20 === 1) {
        addLog(`⏳ 档位未就绪，继续等待... (第${attempts}次尝试) ${res?.message ? '（'+res.message+'）' : ''}`)
      }
    } catch (e) {
      if (attempts % 20 === 1) {
        addLog(`❌ 获取档位失败，继续重试... (第${attempts}次尝试) ${e.message || e}`)
      }
    }
    await sleep(200)
  }
}

async function getTicketWithRetry() {
  let attempts = 0
  addLog('🎫 开始获取入场票据...')
  
  while (true) {
    if (aborted.value) throw new Error('已停止')
    attempts++
    try {
      const res = await ticketClient.get('/entry')
      const entryTicket = res?.data?.ticket
      if (entryTicket) {
        addLog(`🎫 获取到票据，正在校验...`)
        // validate ticket
        const check = await grab.post('/ai-smart-subsidy-approval/api/queue/ticket/check', { ticket: entryTicket })
        if (check?.success) {
          addLog(`✅ 票据校验通过！${check?.message ? '：'+check.message : ''}`)
          return entryTicket
        } else {
          addLog(`❌ 票据校验未通过${check?.message ? '：'+check.message : ''}，重新获取`)
        }
      } else if (attempts % 20 === 1) {
        addLog(`⏳ 票据未就绪，继续等待... (第${attempts}次尝试) ${res?.message ? '（'+res.message+'）' : ''}`)
      }
    } catch (e) {
      if (attempts % 20 === 1) {
        addLog(`❌ 获取/校验票据失败，继续重试... (第${attempts}次尝试) ${e.message || e}`)
      }
    }
    await sleep(200)
  }
}

async function submitApplyOnce({ uniqueIdVal, positionId, ticket, foodSubsidyId }) {
  const payload = { uniqueId: String(uniqueIdVal), tourismSubsidyId: positionId, ticket }
  if (foodSubsidyId) payload.foodSubsidyId = foodSubsidyId
  return grab.post('/ai-smart-subsidy-approval/api/apply/submitApply', payload)
}

async function submitApplyWithRetry({ uniqueIdVal, positionId, ticket, foodSubsidyId }) {
  let attempts = 0
  let currentTicket = ticket
  while (true) {
    if (aborted.value) throw new Error('已停止')
    attempts++
    try {
      addLog(`正在提交申请... (第${attempts}次尝试)`)
      const res = await submitApplyOnce({ uniqueIdVal, positionId, ticket: currentTicket, foodSubsidyId })
      
      // 判断是否成功或重复提交
      const isSuccess = res?.success === true
      const isDuplicate = !isSuccess && res?.message && res.message.includes("重复提交")
      
      if (isSuccess) {
        addLog(`🎉 抢购成功！${res?.message || ''}`)
        return { success: true, isDuplicate: false }
      } else if (isDuplicate) {
        addLog(`⚠️ 重复提交：用户已在其他渠道提交成功 - ${res?.message || ''}`)
        return { success: true, isDuplicate: true }
      }
      
      // 处理其他错误情况
      const msg = res?.message || ''
      const code = res?.code || ''
      
      if (code === 'TICKET_INVALID' || /票据无效|过期/.test(msg)) {
        addLog(`🔄 ticket无效/过期，重新获取ticket... ${code ? '['+code+'] ' : ''}${msg}`)
        currentTicket = await getTicketWithRetry()
        continue
      }
      
      // 记录失败日志
      if (attempts % 10 === 1) {
        addLog(`❌ 提交失败，继续重试... ${code ? '['+code+'] ' : ''}${msg || '未知错误'}`)
      }
    } catch (e) {
      if (attempts % 10 === 1) {
        addLog(`💥 提交异常，继续重试... ${e.message || e}`)
      }
    }
    await sleep(200)
  }
}

async function submitMultiQuotasWithService({ uniqueIdVal, quotas, ticket }) {
  try {
    const payload = {
      uniqueId: String(uniqueIdVal),
      ticket,
      quotas: quotas.map(q => ({ tourismSubsidyId: q.tourismSubsidyId, ...(q.foodSubsidyId ? { foodSubsidyId: q.foodSubsidyId } : {}) })),
    }
    const res = await submitClient.post('/apply', payload)
    return res
  } catch (e) {
    return { success: false, message: e.message || String(e) }
  }
}

async function getPositionsForQuotasWithRetry(amounts) {
  const targets = (amounts || []).map(a => Number(a)).filter(a => !Number.isNaN(a))
  let attempts = 0
  addLog(`🔍 开始获取档位信息（多档位），目标补贴：${targets.join(', ')}`)
  while (true) {
    if (aborted.value) throw new Error('已停止')
    attempts++
    try {
      const res = await grab.post('/ai-smart-subsidy-approval/api/apply/getApplySubsidyPositionList')
      const list = res?.data?.tourismSubsidyPositions || []
      const foodList = res?.data?.foodSubsidyPositions || []
      let foodId = null
      if (Array.isArray(foodList) && foodList.length > 0) {
        const maxFood = foodList.reduce((a, b) => Number(a.subsidyAmount) >= Number(b.subsidyAmount) ? a : b)
        foodId = maxFood?.id ?? null
      }
      const mapping = {}
      let allFound = true
      for (const amt of targets) {
        const match = list.find(x => Number(x.subsidyAmount) === Number(amt))
        if (match?.id) {
          mapping[amt] = match.id
        } else {
          allFound = false
        }
      }
      if (allFound) {
        addLog(`✅ 多档位匹配成功！ids=${targets.map(a => mapping[a]).join(', ')}${res?.message ? '：'+res.message : ''}`)
        return { tourismIdByAmount: mapping, foodId }
      }
      if (attempts % 20 === 1) {
        addLog(`⏳ 档位未就绪（多档位），继续等待... (第${attempts}次尝试) ${res?.message ? '（'+res.message+'）' : ''}`)
      }
    } catch (e) {
      if (attempts % 20 === 1) {
        addLog(`❌ 获取档位失败（多档位），继续重试... (第${attempts}次尝试) ${e.message || e}`)
      }
    }
    await sleep(200)
  }
}

async function startGrab() {
  if (!isLoggedIn.value) {
    addLog('请先登录')
    return
  }
  if (!selectedQuota.value) {
    addLog('请先选择档位')
    return
  }
  aborted.value = false
  isPurchasing.value = true
  addLog(`🚀 开始抢购流程，档位：${selectedQuota.value}`)
  
  try {
    addLog('📋 确保uniqueId已获取...')
    await ensureUniqueId()
    
    if (selectedQuotas.value && selectedQuotas.value.length > 1) {
      addLog('🎯 获取档位信息（多档位）...')
      const { tourismIdByAmount, foodId } = await getPositionsForQuotasWithRetry(selectedQuotas.value)
      addLog('🎫 获取入场票据...')
      const tk = await getTicketWithRetry()
      addLog('📤 开始提交申请（多档位并发）...')
      const quotasPayload = selectedQuotas.value.map(amt => ({ tourismSubsidyId: tourismIdByAmount[Number(amt)], ...(foodId ? { foodSubsidyId: foodId } : {}) }))
      const resp = await submitMultiQuotasWithService({ uniqueIdVal: uniqueId.value, quotas: quotasPayload, ticket: tk })
      if (resp?.success) {
        playSuccessAudioOnce()
        if (SCT_SEND_URL.value) {
          await sendPushOnSuccess({
            name: user.value?.name || '用户',
            phone: user.value?.phone || '',
            quota: selectedQuotas.value.join(','),
            time: new Date().toLocaleString(),
            uniqueId: uniqueId.value,
            isDuplicate: !!resp?.isDuplicate
          })
        }
        addLog(`✅ 抢购流程完成！状态：${resp?.isDuplicate ? '重复提交' : '首次成功'}`)
      } else {
        addLog(`❌ 并发提交失败：${resp?.message || '未知错误'}`)
      }
    } else {
      addLog('🎯 获取档位信息...')
      const { tourismId, foodId } = await getPositionsWithRetry()
      addLog('🎫 获取入场票据...')
      const ticket = await getTicketWithRetry()
      addLog('📤 开始提交申请...')
      const result = await submitApplyWithRetry({ uniqueIdVal: uniqueId.value, positionId: tourismId, foodSubsidyId: foodId, ticket })
      if (result?.success) {
        playSuccessAudioOnce()
        if (SCT_SEND_URL.value) {
          await sendPushOnSuccess({
            name: user.value?.name || '用户',
            phone: user.value?.phone || '',
            quota: selectedQuota.value,
            time: new Date().toLocaleString(),
            uniqueId: uniqueId.value,
            isDuplicate: result.isDuplicate || false
          })
        }
        addLog(`✅ 抢购流程完成！状态：${result.isDuplicate ? '重复提交' : '首次成功'}`)
      }
    }
  } catch (e) {
    addLog(`💥 抢购流程异常：${e.message || e}`)
  } finally {
    isPurchasing.value = false
    addLog('🏁 抢购流程结束')
  }
}

// ===== Purchase control =====
const startTime = ref('09:59:58')
const countdownText = ref('')
const isCounting = ref(false)
let timerId = null

function computeTargetDate(timeStr) {
  const [hh, mm, ss] = timeStr.split(':').map(v => parseInt(v, 10))
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, ss, 0)
}

function formatMs(ms) {
  const sign = ms < 0 ? '-' : ''
  ms = Math.abs(ms)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const msRemain = Math.floor(ms % 1000)
  return `${sign}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(msRemain).padStart(3,'0')}`
}

function formatTime(date) {
  const pad = (n, w=2) => String(n).padStart(w, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const isLoggedIn = computed(() => !!(user.value && user.value.token))
const nowText = ref('')
const startTargetText = ref('')
const deviceTimeText = ref('')
let deviceClockId = null

const quotaEditingId = ref('')
const quotaEditingValues = ref([])

function startEditQuotasForAccount(acc) {
  quotaEditingId.value = acc.id
  quotaEditingValues.value = Array.isArray(acc.quotas) ? [...acc.quotas] : []
}
function cancelEditQuotas() {
  quotaEditingId.value = ''
  quotaEditingValues.value = []
}
function saveEditQuotas(accId) {
  const idx = accounts.value.findIndex(a => a.id === accId)
  if (idx < 0) return
  const set = new Set((quotaEditingValues.value || []).map(v => Number(v)).filter(v => !Number.isNaN(v)))
  accounts.value[idx] = { ...accounts.value[idx], quotas: Array.from(set) }
  persistAccounts()
  if (activeAccountId.value === accId) {
    selectedQuotas.value = Array.from(set)
    selectedQuota.value = selectedQuotas.value[0] || null
  }
  addLog(`已更新账号档位：${accounts.value[idx].name || ''} ${maskPhone(accounts.value[idx].phone)} → ${accounts.value[idx].quotas && accounts.value[idx].quotas.length ? accounts.value[idx].quotas.join(', ') : '未设置'}`)
  cancelEditQuotas()
}

function onStartClick() {
  if (!isLoggedIn.value) {
    addLog('请先登录再开始抢购')
    return
  }
  unlockSuccessAudio()
  if (selectedQuotas.value && selectedQuotas.value.length > 0) {
    quotaTempMulti.value = [...selectedQuotas.value]
    confirmQuotaThenStart()
  } else {
    quotaTemp.value = selectedQuota.value || 800
    quotaTempMulti.value = []
    quotaVisible.value = true
  }
}

function confirmQuotaThenStart() {
  // Backward compatibility: if no multi selected, use single
  const list = Array.isArray(quotaTempMulti.value) && quotaTempMulti.value.length > 0
    ? [...new Set(quotaTempMulti.value.map(v => Number(v)))]
    : [Number(quotaTemp.value || 800)]
  selectedQuotas.value = list
  selectedQuota.value = list[0] || null
  quotaVisible.value = false
  addLog(`选择档位：${list.join(', ')}，进入预备状态（并发/档位=${perQuotaConcurrency.value}）`)
  const target = computeTargetDate(startTime.value)
  const diff = target.getTime() - Date.now()
  if (diff <= 0) {
    addLog('设置时间已过，立即开始抢购')
    startGrab()
    return
  }
  startTargetText.value = formatTime(target)
  startCountdownInternal(target)
}

function startCountdownInternal(target) {
  addLog(`已设置开始时间：${startTime.value}，倒计时开始`)
  isCounting.value = true
  clearInterval(timerId)
  timerId = setInterval(() => {
    const now = new Date()
    const d = target.getTime() - now.getTime()
    nowText.value = `${formatTime(now)}`
    if (d <= 0) {
      countdownText.value = '00:00:00.000'
      stopCountdown()
      startGrab()
    } else {
      countdownText.value = formatMs(d)
    }
  }, 250)
}

function stopCountdown() {
  if (timerId) clearInterval(timerId)
  timerId = null
  isCounting.value = false
  addLog('倒计时已停止')
}

function onStopAll() {
  aborted.value = true
  stopCountdown()
  isPurchasing.value = false
  addLog('已手动停止当前流程')
}

onMounted(async () => {
  // prepare success audio element
  prepareSuccessAudio()
  
  // initialize proxy state
  initProxyState()

  // Load accounts first
  try {
    const savedAccounts = JSON.parse(localStorage.getItem('accounts') || '[]')
    if (Array.isArray(savedAccounts)) accounts.value = savedAccounts
    activeAccountId.value = localStorage.getItem('activeAccountId') || ''
  } catch {}

  if (accounts.value.length === 0) {
    // migrate legacy single auth
    const saved = localStorage.getItem('auth')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (parsed?.token) {
          const acc = upsertAccount({ name: parsed.name || '用户', token: parsed.token, phone: parsed.phone || '', accId: localStorage.getItem('accId') || '', grabToken: localStorage.getItem('grabToken') || '', ticketSNO: localStorage.getItem('ticketSNO') || '', uniqueId: localStorage.getItem('uniqueId') || '', quotas: parsed.quotas || [] })
          activeAccountId.value = acc.id
        }
      } catch {}
    }
  }

  if (activeAccountId.value) {
    const acc = accounts.value.find(a => a.id === activeAccountId.value) || accounts.value[0]
    if (acc) {
      applyActiveAccount(acc)
      await refreshGrabAuthAndUniqueId()
    }
  }

  // device clock every second
  deviceTimeText.value = formatTime(new Date())
  deviceClockId = setInterval(() => {
    deviceTimeText.value = formatTime(new Date())
  }, 1000)
})

onBeforeUnmount(() => {
  if (timerId) clearInterval(timerId)
  if (deviceClockId) clearInterval(deviceClockId)
})
</script>

<template>
  <div id="page">
    <section class="panel">
      <h2>推送配置</h2>
      <div class="row">
        <input class="input" type="text" placeholder="Server酱 Send Key" v-model.trim="sctKey" :disabled="sctLocked" />
        <button class="btn secondary" v-if="!sctLocked" @click="saveSctKey" :disabled="!sctKey">保存并锁定</button>
        <button class="btn" v-else @click="unlockSctKey">解锁</button>
        <button class="btn primary" @click="sendTestPush" :disabled="!SCT_SEND_URL">测试推送</button>
      </div>
      <div class="hint">当前Key：{{ sctKey ? (sctLocked ? sctDisplay : '未锁定') : '未设置' }}；推送通道固定：9（服务号）</div>
    </section>

    <section class="panel">
      <h2>登录</h2>
      <div v-if="!isLoggedIn" class="form-grid">
        <input
          class="input"
          type="tel"
          placeholder="请输入手机号"
          v-model.trim="phone"
          maxlength="11"
        />
        <div class="row">
          <input
            class="input"
            type="text"
            placeholder="短信验证码"
            v-model.trim="smsCode"
          />
          <button class="btn secondary" :disabled="smsSending || !/^\d{11}$/.test(phone)" @click="onClickSendSms">发送短信</button>
        </div>
        <button class="btn primary" :disabled="isLoggingIn" @click="onLogin">
          {{ isLoggingIn ? '登陆中...' : '登录' }}
        </button>
      </div>
      <div v-else class="user-box">
        <div class="user-info">
          <div>姓名：{{ user.name }}</div>
          <div>手机号：{{ user.phone }}</div>
        </div>
        <div class="row">
          <button class="btn" @click="openAccounts">账号列表</button>
          <button class="btn" @click="onLogout">退出登录</button>
        </div>
      </div>
      <div v-if="isLoggedIn" class="row">
        <button class="btn small" @click="onExportUser">导出</button>
        <button class="btn small" @click="onExportAllAccounts">导出全部</button>
      </div>
      <div class="row">
        <button class="btn small" @click="openImportUser">导入</button>
        <button class="btn small" @click="onPickImportFile">文件导入</button>
      </div>
    </section>

    <section class="panel">
      <h2>抢购控制</h2>
      <div class="control-stack">
        <div class="time-row">设备时间：{{ deviceTimeText }}</div>
        <div class="row">
          <label class="proxy-toggle">
            <input type="checkbox" v-model="useProxyForWindow" @change="onToggleProxy" />
            <span>使用代理IP（当前窗口）</span>
          </label>
        </div>
        <label class="label">开始时间</label>
        <input class="input time-input" type="time" step="1" v-model="startTime" />
        <div class="row">
          <button class="btn primary" @click="onStartClick" :disabled="isPurchasing || isCounting">开始抢购</button>
          <button class="btn" @click="onStopAll" :disabled="!(isCounting || isPurchasing)">停止</button>
        </div>
        <div class="hint" v-if="selectedQuotas && selectedQuotas.length">已选择档位：{{ selectedQuotas.join(', ') }}（并发/档位：{{ perQuotaConcurrency }}）</div>
        <div class="hint">网络模式：{{ useProxyForWindow ? '代理IP' : '直连IP（本机IP）' }}</div>
      </div>
      <div class="countdown" v-if="isCounting">
        倒计时：{{ countdownText }}
        <div class="time-row">当前时间：{{ nowText }} ｜ 开始时间：{{ startTargetText }}</div>
      </div>
      <div class="hint" v-else>未开始，默认 {{ startTime }}（若已过当前时间，将立即开始）</div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>请求日志</h2>
        <button class="btn small" @click="clearLogs" :disabled="logs.length===0">清空</button>
      </div>
      <div class="log-box">
        <div v-if="logs.length===0" class="log-empty">暂无日志</div>
        <div v-else class="log-list">
          <div v-for="(line, idx) in logs" :key="idx" class="log-line">{{ line }}</div>
        </div>
      </div>
    </section>

    <!-- Captcha Modal -->
    <div v-if="captchaVisible" class="modal-mask" @click.self="captchaVisible=false">
      <div class="modal">
        <div class="modal-title">图形验证</div>
        <div class="modal-body">
          <div class="cap-row">
            <img v-if="captchaImage" :src="captchaImage" class="captcha-img" @click="fetchCaptcha" title="点击刷新" />
            <button class="btn small" @click="fetchCaptcha">刷新</button>
          </div>
          <input class="input" type="text" placeholder="请输入图形验证码" v-model.trim="imageCode" />
        </div>
        <div class="modal-actions">
          <button class="btn" @click="captchaVisible=false">取消</button>
          <button class="btn primary" :disabled="smsSending || !imageCode" @click="confirmCaptchaAndSendSms">确认发送</button>
        </div>
      </div>
    </div>

    <!-- Quota Modal -->
    <div v-if="quotaVisible" class="modal-mask" @click.self="quotaVisible=false">
      <div class="modal">
        <div class="modal-title">选择档位</div>
        <div class="modal-body">
          <div class="quota-options">
            <label class="radio"><input type="checkbox" value="1500" v-model.number="quotaTempMulti" /> 1500</label>
            <label class="radio"><input type="checkbox" value="800" v-model.number="quotaTempMulti" /> 800</label>
            <label class="radio"><input type="checkbox" value="300" v-model.number="quotaTempMulti" /> 300</label>
            <label class="radio"><input type="checkbox" value="3000" v-model.number="quotaTempMulti" /> 3000</label>
          </div>
          <div class="row">
            <label class="label">并发/档位</label>
            <input class="input" type="number" min="1" max="20" v-model.number="perQuotaConcurrency" />
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="quotaVisible=false">取消</button>
          <button class="btn primary" @click="confirmQuotaThenStart">确定</button>
        </div>
      </div>
    </div>

    <!-- Import Modal -->
    <div v-if="importVisible" class="modal-mask" @click.self="importVisible=false">
      <div class="modal">
        <div class="modal-title">导入用户信息（{{ importMode==='file' ? ('文件：'+importFileName) : '粘贴JSON' }}）</div>
        <div class="modal-body">
          <textarea class="input" rows="8" placeholder="粘贴导出的JSON" v-model.trim="importText"></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="importVisible=false">取消</button>
          <button class="btn primary" @click="importMode==='file' ? onConfirmImportFileOverwrite() : onConfirmImport()">确认导入</button>
        </div>
      </div>
    </div>

    <!-- Accounts Modal -->
    <div v-if="accountsVisible" class="modal-mask" @click.self="closeAccounts()">
      <div class="modal">
        <div class="modal-title">账号列表（{{ accounts.length }}）</div>
        <div class="modal-body">
          <div v-if="accounts.length===0" class="hint">暂无账号</div>
          <div v-else class="acc-list">
            <div class="acc-row" v-for="acc in accounts" :key="acc.id">
              <div class="acc-info">
                <div class="acc-name">{{ acc.name }}</div>
                <div class="acc-phone">{{ (acc.phone || '').replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') }}</div>
                <div class="hint">档位：{{ Array.isArray(acc.quotas) && acc.quotas.length ? acc.quotas.join(', ') : '未设置' }}</div>
                <div v-if="quotaEditingId===acc.id" class="quota-options" style="margin-top:6px;">
                  <label class="radio"><input type="checkbox" value="1500" v-model.number="quotaEditingValues" /> 1500</label>
                  <label class="radio"><input type="checkbox" value="800" v-model.number="quotaEditingValues" /> 800</label>
                  <label class="radio"><input type="checkbox" value="300" v-model.number="quotaEditingValues" /> 300</label>
                  <label class="radio"><input type="checkbox" value="3000" v-model.number="quotaEditingValues" /> 3000</label>
                </div>
              </div>
              <div class="acc-actions">
                <button class="btn small" :disabled="activeAccountId===acc.id || quotaEditingId===acc.id" @click="switchAccount(acc.id)">{{ activeAccountId===acc.id ? '当前' : '切换' }}</button>
                <button class="btn small" @click="deleteAccount(acc.id)" :disabled="accounts.length<=1 && activeAccountId===acc.id || quotaEditingId===acc.id">删除</button>
                <button class="btn small" v-if="quotaEditingId!==acc.id" @click="startEditQuotasForAccount(acc)" :disabled="activeAccountId!==acc.id">编辑</button>
                <button class="btn small" v-else @click="saveEditQuotas(acc.id)">保存</button>
                <button class="btn small" v-if="quotaEditingId===acc.id" @click="cancelEditQuotas">取消</button>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="closeAccounts()">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
#page {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 720px;
  margin: 0 auto;
  text-align: left;
}

.panel {
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 1rem;
  background: var(--c-surface-1);
}

h2 {
  margin: 0 0 0.75rem 0;
  font-size: 1.1rem;
}

.form-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.label {
  min-width: 72px;
  color: var(--c-muted);
}

.control-stack {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.time-input {
  max-width: 200px;
}

.input {
  width: 100%;
  padding: 0.6em 0.8em;
  border-radius: 8px;
  border: 1px solid var(--c-border);
  background-color: var(--c-surface-2);
  color: var(--c-text);
  transition: border-color 0.2s, background-color 0.2s;
}

.input::placeholder {
  color: var(--c-muted);
}

.input:focus {
  outline: none;
  border-color: var(--c-primary);
  box-shadow: var(--ring);
}

.btn {
  border-radius: 8px;
  border: 1px solid var(--c-border);
  padding: 0.6em 1.2em;
  background-color: var(--c-surface-2);
  color: inherit;
  cursor: pointer;
  transition: border-color 0.25s, background-color 0.2s, color 0.2s;
}

.btn.small {
  padding: 0.4em 0.8em;
  font-size: 0.9em;
}

.btn:hover {
  border-color: var(--c-primary);
}

.btn:focus-visible {
  outline: none;
  border-color: var(--c-primary);
  box-shadow: var(--ring);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn.primary {
  background-color: var(--c-primary);
  color: #fff;
  border-color: transparent;
}

.btn.primary:hover {
  background-color: var(--c-primary-600);
}

.btn.secondary {
  background-color: var(--c-surface-2);
}

.user-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hint {
  margin-top: 0.5rem;
  color: var(--c-muted);
}

.current {
  margin-top: 0.5rem;
}

.countdown {
  margin-top: 0.5rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.time-row {
  margin-top: 0.25rem;
  font-size: 0.95rem;
  color: var(--c-muted);
}

.log-box {
  height: 220px;
  border: 1px dashed var(--c-border);
  border-radius: 8px;
  padding: 0.6rem;
  background: var(--c-surface-2);
  overflow: hidden;
}

.log-list {
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.log-line {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.9rem;
}

.log-empty {
  text-align: center;
  color: var(--c-muted);
  padding-top: 2.5rem;
}

/* Modal */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  width: 460px;
  background: var(--c-surface-1);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 1rem;
  max-height: 500px;
  overflow: auto;
}

.modal-title {
  font-weight: 600;
  margin-bottom: 0.5rem;
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.cap-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.captcha-img {
  height: 38px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: #fff;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.quota-options {
  display: flex;
  gap: 1rem;
}

.radio {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

textarea.input {
  resize: vertical;
}

.acc-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.acc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem;
  border: 1px dashed var(--c-border);
  border-radius: 8px;
}

.acc-info {
  display: flex;
  flex-direction: column;
}

.acc-name {
  font-weight: 600;
}

.acc-phone {
  color: var(--c-muted);
}

.proxy-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  cursor: pointer;
}

.proxy-toggle input[type="checkbox"] {
  width: auto;
  margin: 0;
}
</style>
