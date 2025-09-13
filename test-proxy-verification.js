// Test tool to verify proxy usage and IP rotation
import fetch from 'node-fetch'

const PROXY_SERVER = 'http://localhost:5179'
const IP_CHECK_SERVICES = [
  'https://httpbin.org/ip',
  'https://api.ipify.org?format=json',
  'https://ipapi.co/ip/'
]

async function checkCurrentIP(service, useProxy = false, proxyKey = 'default') {
  try {
    // For proxy requests, we need to use the correct path structure
    const url = useProxy ? `${PROXY_SERVER}/grab/ip` : service
    const headers = useProxy ? { 'x-proxy-key': proxyKey } : {}
    
    console.log(`\n🔍 Checking IP via ${useProxy ? 'PROXY' : 'DIRECT'} ${useProxy ? `(key: ${proxyKey})` : ''}`)
    console.log(`   Target: ${url}`)
    
    const response = await fetch(url, { 
      headers,
      timeout: 10000 
    })
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const text = await response.text()
    console.log(`   Raw response: ${text.trim().substring(0, 200)}...`)
    
    try {
      const json = JSON.parse(text)
      const ip = json.ip || json.origin || Object.values(json)[0]
      console.log(`   ✅ IP: ${ip}`)
      return ip
    } catch {
      // If not JSON, assume it's plain text IP
      const ip = text.trim()
      console.log(`   ✅ IP: ${ip}`)
      return ip
    }
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`)
    return null
  }
}

async function checkProxyStatus() {
  try {
    console.log('\n📊 Checking proxy status...')
    const response = await fetch(`${PROXY_SERVER}/proxy-status`)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const status = await response.json()
    console.log('   Current status:', JSON.stringify(status, null, 2))
    return status
  } catch (error) {
    console.log(`   ❌ Error checking proxy status: ${error.message}`)
    return null
  }
}

async function testProxyVerification() {
  console.log('🚀 Proxy IP Verification Test')
  console.log('='.repeat(50))
  
  // Test 1: Check direct IP
  console.log('\n📍 Step 1: Check your direct IP')
  const directIP = await checkCurrentIP(IP_CHECK_SERVICES[0], false)
  
  // Test 2: Check proxy IP with different keys
  console.log('\n📍 Step 2: Check proxy IP (key: default)')
  const proxyIP1 = await checkCurrentIP(IP_CHECK_SERVICES[0], true, 'default')
  
  console.log('\n📍 Step 3: Check proxy IP (key: session1)')
  const proxyIP2 = await checkCurrentIP(IP_CHECK_SERVICES[0], true, 'session1')
  
  console.log('\n📍 Step 4: Check proxy IP (key: session2)')
  const proxyIP3 = await checkCurrentIP(IP_CHECK_SERVICES[0], true, 'session2')
  
  // Summary
  console.log('\n📊 SUMMARY')
  console.log('='.repeat(30))
  console.log(`Direct IP:      ${directIP || 'Failed'}`)
  console.log(`Proxy (default): ${proxyIP1 || 'Failed'}`)
  console.log(`Proxy (session1): ${proxyIP2 || 'Failed'}`)
  console.log(`Proxy (session2): ${proxyIP3 || 'Failed'}`)
  
  if (directIP && proxyIP1) {
    if (directIP === proxyIP1) {
      console.log('\n⚠️  WARNING: Proxy IP is same as direct IP (likely using direct connection)')
    } else {
      console.log('\n✅ SUCCESS: Proxy is working! Different IPs detected.')
    }
  }
}

async function testIPRotation() {
  console.log('\n\n🔄 IP Rotation Test')
  console.log('='.repeat(50))
  
  const key = 'rotation-test'
  const checks = []
  
  for (let i = 1; i <= 5; i++) {
    console.log(`\n🔍 Check #${i}`)
    const ip = await checkCurrentIP(IP_CHECK_SERVICES[0], true, key)
    checks.push({ check: i, ip, time: new Date().toLocaleTimeString() })
    
    if (i < 5) {
      console.log('   ⏱️  Waiting 3 seconds...')
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
  
  console.log('\n📊 ROTATION SUMMARY')
  console.log('='.repeat(30))
  checks.forEach(({ check, ip, time }) => {
    console.log(`Check ${check} (${time}): ${ip || 'Failed'}`)
  })
  
  const uniqueIPs = [...new Set(checks.map(c => c.ip).filter(Boolean))]
  console.log(`\nUnique IPs detected: ${uniqueIPs.length}`)
  if (uniqueIPs.length > 1) {
    console.log('✅ IP rotation is working!')
  } else {
    console.log('⚠️  No IP rotation detected (may be normal if proxies haven\'t expired)')
  }
}

// Main execution
async function main() {
  console.log('🏁 Starting Proxy Verification Tests...\n')
  
  try {
    // First check if proxy server is running and what its status is
    await checkProxyStatus()
    
    await testProxyVerification()
    await testIPRotation()
  } catch (error) {
    console.error('\n❌ Test failed:', error.message)
  }
  
  console.log('\n🏁 Tests completed!')
}

main().catch(console.error)
