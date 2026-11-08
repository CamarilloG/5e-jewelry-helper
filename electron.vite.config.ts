import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      // 运行时依赖全部打进主进程产物，安装包不携带 node_modules
      externalizeDeps: false,
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          dbWorker: resolve(__dirname, 'src/main/storage/worker.ts'),
          preview: resolve(__dirname, 'src/main/preview/server.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // 沙盒 preload 只能 require('electron')，其余依赖必须打包
      externalizeDeps: false,
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      chunkSizeWarningLimit: 2500,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
        onwarn(warning, handler) {
          // antd 组件的 "use client" 指令在桌面单页中无意义
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client'))
            return;
          handler(warning);
        },
      },
    },
  },
});
