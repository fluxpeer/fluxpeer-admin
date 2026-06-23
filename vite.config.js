import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  server: {
    // Dev: forward API + WS to the control-server. Override the target with
    // FP_CONTROL=http://host:port for testing against a remote control-server.
    proxy: {
      '/api': { target: process.env.FP_CONTROL || 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
    },
  },
})
