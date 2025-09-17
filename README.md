# Vue 3 + Vite

This template should help get you started developing with Vue 3 in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about IDE Support for Vue in the [Vue Docs Scaling up Guide](https://vuejs.org/guide/scaling-up/tooling.html#ide-support).

---

## Ticket Service (High-concurrency ticket acquisition)

- Start all services:
  - `npm run dev:all` (starts Vite, general proxy, and ticket service)
- Ticket service config: `ticket.config.js`
  - `serverPort`: default 5180
  - `concurrency`: per wave requests, default 10 (1 direct + 9 proxies)
  - `useDirectPerWave`: whether to include one direct request per wave
  - `waveDelayMs`: delay between waves on null-ticket, default 50ms
  - `globalTimeoutMs`: overall timeout for a single request
  - `upstream.providerUrl`: proxy provider URL (same structure as general proxy)
  - `upstream.proxyScheme`: `http` | `https` | `socks5`
- Frontend integration:
  - Axios client at `src/api/ticket.js`
  - `App.vue` uses `/ticket/entry` instead of direct `/grab` for ticket fetching, then continues original validation flow
- Logs:
  - Written to `logs/tickets/YYYY-MM-DD.log`
  - Records per wave plan, proxy or direct used, response status, and whether ticket was hit
