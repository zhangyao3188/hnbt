import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'https://onecode-appservice.digitalhainan.com.cn',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/grab': {
        target: 'https://ai-smart-subsidy-backend.digitalhainan.com.cn',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/grab/, ''),
      },
    },
  },
})
