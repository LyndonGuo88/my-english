import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

const ortDist = join(process.cwd(), "node_modules", "onnxruntime-web", "dist");
const ortFiles = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
];

function copyOrtRuntime() {
  const dest = join(process.cwd(), "public", "ort");
  mkdirSync(dest, { recursive: true });
  for (const file of ortFiles) {
    cpSync(join(ortDist, file), join(dest, file));
  }
}

const forApk = process.env.CAPACITOR_BUILD === "1";
// 部署到 GitHub Pages 项目站点时用 VITE_BASE=/仓库名/ 构建；APK 和本地开发保持根路径。
const base = forApk ? "/" : process.env.VITE_BASE || "/";

export default defineConfig({
  base,
  server: {
    host: true,
    // tools/ 里是便携版 Node 和 Git，上万个文件，不要让 Vite 去监听，
    // 否则解压它们时会触发一堆全页刷新。
    watch: { ignored: ["**/tools/**", "**/my-english.zip"] },
  },
  preview: { host: true },
  resolve: forApk ? {
    alias: {
      "virtual:pwa-register": resolve(process.cwd(), "src/pwa-stub.js"),
    },
  } : undefined,
  optimizeDeps: {
    exclude: ["@huggingface/transformers"],
  },
  plugins: [
    {
      name: "copy-ort-runtime",
      buildStart: copyOrtRuntime,
      configureServer: copyOrtRuntime,
    },
    VitePWA({
      disable: forApk,
      registerType: "autoUpdate",
      injectRegister: null,
      includeAssets: ["favicon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "中译英朗读",
        short_name: "中译英",
        description: "离线把中文译成英文，显示音标并朗读",
        lang: "zh-CN",
        display: "standalone",
        start_url: base,
        background_color: "#f4f1ea",
        theme_color: "#1f4b3a",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,wasm,json}"],
        globIgnores: ["**/models/**"],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        runtimeCaching: [
          {
            // 模型不随站点预缓存，首次由 transformers 从 hf-mirror 拉并写入浏览器缓存；
            // 这里再给镜像侧一道 CacheFirst 保险（同源不会命中，不会与预缓存重复存）。
            urlPattern: /^https:\/\/hf-mirror\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "translation-model",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/dict\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "ipa-dict",
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: !forApk },
    }),
  ],
});
