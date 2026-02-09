import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    define: {
      'import.meta.env.AWS_ACCESS_KEY_ID': JSON.stringify(env.AWS_ACCESS_KEY_ID ?? ''),
      'import.meta.env.AWS_SECRET_ACCESS_KEY': JSON.stringify(env.AWS_SECRET_ACCESS_KEY ?? ''),
      'import.meta.env.AWS_SESSION_TOKEN': JSON.stringify(env.AWS_SESSION_TOKEN ?? ''),
      'import.meta.env.AWS_REGION': JSON.stringify(env.AWS_REGION ?? ''),
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  }
})
