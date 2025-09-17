import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5175,
    proxy: {
      '/api': {
        target: 'https://onecode-appservice.digitalhainan.com.cn',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/grab': {
        target: 'http://localhost:5179',
        changeOrigin: true,
        secure: false,
        // 保留 /grab 前缀，由本地 Node 代理再去移除
      },
      '/ticket': {
        target: 'http://localhost:5180',
        changeOrigin: true,
        secure: false,
      },
      '/submit': {
        target: 'http://localhost:5181',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
