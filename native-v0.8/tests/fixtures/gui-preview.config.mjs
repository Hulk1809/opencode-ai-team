import {defineConfig} from 'vite';
import solid from 'vite-plugin-solid';
import {fileURLToPath} from 'node:url';
export default defineConfig({plugins:[solid()],resolve:{alias:{'@opencode/plugin/gui':fileURLToPath(new URL('./gui-plugin.tsx',import.meta.url))}},server:{host:'127.0.0.1',port:4178,strictPort:true},build:{outDir:'.isolated/gui-preview',rollupOptions:{input:'tests/fixtures/gui-preview.html'}}});
