import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./web',import.meta.url)),
  publicDir: fileURLToPath(new URL('./web/public',import.meta.url)),
  plugins:[react()],
  resolve:{alias:{'@':fileURLToPath(new URL('../',import.meta.url))}},
  build:{outDir:fileURLToPath(new URL('../outputs/next-web/dist',import.meta.url)),emptyOutDir:true},
});
