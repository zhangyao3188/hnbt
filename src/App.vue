<script setup>
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import request, { setAuthToken } from './api/request'
import grab, { setGrabAuthToken } from './api/grab'

// ===== Auth state =====
const phone = ref('')
const smsCode = ref('')
const isLoggingIn = ref(false)
const user = ref(null) // { id, phone(masked), name, token }

// Captcha & SMS state (modal flow)
const captchaImage = ref('') // data URL
const imageKey = ref('')
const imageCode = ref('')
const smsSending = ref(false)
const captchaVisible = ref(false)

// Purchase related state
const selectedQuota = ref(null) // 800 or 300
const quotaVisible = ref(false)
const quotaTemp = ref(800)
const uniqueId = ref('')
const isPurchasing = ref(false)

// Logs
const logs = ref([])

function addLog(message) {
  const timestamp = new Date().toLocaleTimeString()
  logs.value.unshift(`[${timestamp}] ${message}`)
}

function clearLogs() {
  logs.value = []
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
      addLog('图形码已获取/刷新')
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
    setGrabAuthToken(ticketSNO)
    localStorage.setItem('grabToken', ticketSNO)
    addLog('已换取抢购系统凭证')
  } catch (e) {
    addLog(`换取抢购系统凭证失败：${e.message || e}`)
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
    if (!token) {
      throw new Error('登录返回缺少token')
    }
    user.value = {
      id: Math.random().toString(36).slice(2, 8),
      phone: phone.value.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
      name,
      token
    }
    setAuthToken(token)
    localStorage.setItem('auth', JSON.stringify({ name, token, phone: phone.value }))
    addLog(`登录成功，欢迎：${name}`)
    // exchange second-system token and get uniqueId
    await exchangeGrabToken()
    await fetchUniqueId()
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
  uniqueId.value = ''
  localStorage.removeItem('auth')
  localStorage.removeItem('grabToken')
  localStorage.removeItem('uniqueId')
  addLog('已退出登录')
}

onMounted(async () => {
  const saved = localStorage.getItem('auth')
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      if (parsed?.token) {
        user.value = {
          id: Math.random().toString(36).slice(2, 8),
          phone: (parsed.phone || '').replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
          name: parsed.name || '用户',
          token: parsed.token
        }
        setAuthToken(parsed.token)
        addLog('已恢复登录状态')
        // restore or exchange grab token
        const savedGrab = localStorage.getItem('grabToken')
        if (savedGrab) {
          setGrabAuthToken(savedGrab)
        } else {
          await exchangeGrabToken()
        }
        uniqueId.value = localStorage.getItem('uniqueId') || ''
        await fetchUniqueId() // refresh uniqueId anyway
      }
    } catch {}
  }
})

// ===== Grab API helpers =====
async function fetchUniqueId() {
  try {
    const res = await grab.post('/ai-smart-subsidy-approval/api/apply/getApplyOverView', {})
    const id = res?.data?.uniqueId
    if (id) {
      uniqueId.value = String(id)
      localStorage.setItem('uniqueId', uniqueId.value)
      addLog(`获取uniqueId成功：${uniqueId.value}`)
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

async function getPositionIdByQuotaWithRetry() {
  let attempts = 0
  while (true) {
    attempts++
    try {
      const res = await grab.post('/ai-smart-subsidy-approval/api/apply/getApplySubsidyPositionList')
      const list = res?.data?.tourismSubsidyPositions || []
      const match = list.find(x => Number(x.subsidyAmount) === Number(selectedQuota.value))
      if (match) {
        addLog(`档位匹配成功，id=${match.id}`)
        return match.id
      }
      if (attempts % 20 === 1) addLog('档位未就绪，重试中...')
    } catch (e) {
      if (attempts % 20 === 1) addLog(`获取档位失败，重试中... ${e.message || e}`)
    }
    await sleep(200)
  }
}

async function getTicketWithRetry() {
  let attempts = 0
  while (true) {
    attempts++
    try {
      const res = await grab.get('/hyd-queue/core/simple/entry')
      const ticket = res?.data?.ticket
      if (ticket) {
        addLog('获取ticket成功')
        return ticket
      }
      if (attempts % 20 === 1) addLog('ticket未就绪，重试中...')
    } catch (e) {
      if (attempts % 20 === 1) addLog(`获取ticket失败，重试中... ${e.message || e}`)
    }
    await sleep(200)
  }
}

async function submitApply({ uniqueIdVal, positionId, ticket }) {
  try {
    const payload = { uniqueId: String(uniqueIdVal), tourismSubsidyId: positionId, ticket }
    const res = await grab.post('/ai-smart-subsidy-approval/api/apply/submitApply', payload)
    if (res?.success) {
      addLog('提交成功！抢购成功')
    } else {
      addLog(`提交结果：${res?.message || '未知'} (success=${String(res?.success)})`)
    }
  } catch (e) {
    addLog(`提交失败：${e.message || e}`)
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
  isPurchasing.value = true
  try {
    await ensureUniqueId()
    const positionId = await getPositionIdByQuotaWithRetry()
    const ticket = await getTicketWithRetry()
    await submitApply({ uniqueIdVal: uniqueId.value, positionId, ticket })
  } catch (e) {
    addLog(`抢购流程异常：${e.message || e}`)
  } finally {
    isPurchasing.value = false
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

const isLoggedIn = computed(() => !!(user.value && user.value.token))

function onStartClick() {
  if (!isLoggedIn.value) {
    addLog('请先登录再开始抢购')
    return
  }
  quotaTemp.value = selectedQuota.value || 800
  quotaVisible.value = true
}

function confirmQuotaThenStart() {
  selectedQuota.value = quotaTemp.value
  quotaVisible.value = false
  addLog(`选择档位：${selectedQuota.value}，进入预备状态`)
  const target = computeTargetDate(startTime.value)
  const diff = target.getTime() - Date.now()
  if (diff <= 0) {
    addLog('设置时间已过，立即开始抢购')
    startGrab()
    return
  }
  startCountdownInternal(target)
}

function startCountdownInternal(target) {
  addLog(`已设置开始时间：${startTime.value}，倒计时开始`)
  isCounting.value = true
  clearInterval(timerId)
  timerId = setInterval(() => {
    const now = Date.now()
    const d = target.getTime() - now
    if (d <= 0) {
      countdownText.value = '00:00:00.000'
      stopCountdown()
      startGrab()
    } else {
      countdownText.value = formatMs(d)
    }
  }, 30)
}

function stopCountdown() {
  if (timerId) clearInterval(timerId)
  timerId = null
  isCounting.value = false
  addLog('倒计时已停止')
}

onBeforeUnmount(() => {
  if (timerId) clearInterval(timerId)
})
</script>

<template>
  <div id="page">
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
        <button class="btn" @click="onLogout">退出登录</button>
      </div>
    </section>

    <section class="panel">
      <h2>抢购控制</h2>
      <div class="control-stack">
        <label class="label">开始时间</label>
        <input class="input time-input" type="time" step="1" v-model="startTime" />
        <div class="row">
          <button class="btn primary" v-if="!isCounting" @click="onStartClick" :disabled="isPurchasing">开始抢购</button>
          <button class="btn" v-else @click="stopCountdown" :disabled="isPurchasing">停止</button>
        </div>
        <div class="hint" v-if="selectedQuota">已选择档位：{{ selectedQuota }}</div>
      </div>
      <div class="countdown" v-if="isCounting">倒计时：{{ countdownText }}</div>
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
            <label class="radio"><input type="radio" value="800" v-model.number="quotaTemp" /> 800</label>
            <label class="radio"><input type="radio" value="300" v-model.number="quotaTemp" /> 300</label>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="quotaVisible=false">取消</button>
          <button class="btn primary" @click="confirmQuotaThenStart">确定</button>
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
  width: 360px;
  background: var(--c-surface-1);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 1rem;
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
</style>
