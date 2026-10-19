import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { MARKING_BASE } from './shared/paths.ts';
export default defineConfig({
  base: MARKING_BASE + '/',
  root: fileURLToPath(new URL('./web',import.meta.url)),
  publicDir: fileURLToPath(new URL('./web/public',import.meta.url)),
  plugins:[react()],
  resolve:{alias:{'@':fileURLToPath(new URL('./web/src',import.meta.url))}},
  server:{host:'127.0.0.1',port:5173,proxy:{'/api/':process.env.SV_DEV_API_TARGET??'http://127.0.0.1:5190'}},
  build:{outDir:fileURLToPath(new URL('./dist',import.meta.url)),emptyOutDir:true},
});
