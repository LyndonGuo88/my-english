import { Capacitor } from "@capacitor/core";
import { env, pipeline } from "@huggingface/transformers";
import { patchedFetch } from "./model-chunks.js";

// 部署到子路径（例如 GitHub Pages 的 /仓库名/）时，素材路径要跟着 base 走。
const BASE_URL = import.meta.env.BASE_URL;
// 翻译模型（约 113MB）随站点同源分发：超过 API 单文件上限的大文件在部署时被
// 切成 ≤4MB 的分片，由 src/model-chunks.js 拦截 fetch 拼回完整模型。同源无 CORS 问题。
const native = Capacitor.isNativePlatform();

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${BASE_URL}models/`;
// transformers 内部用自己的 env.fetch（而非 globalThis.fetch），这里显式指向分片拼接补丁，
// 保证大模型请求会被拦截、从同源分片拼回。不依赖模块加载顺序。
env.fetch = patchedFetch;
if (native) {
  // APK 内模型是完整文件（构建期已放好），无需浏览器缓存/WASM 缓存。
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.useCustomCache = false;
} else {
  // web 端首次拼接后把模型存进浏览器 Cache API，下次/断网直接读缓存。
  env.useBrowserCache = true;
}

const wasm = env.backends.onnx.wasm;
const remotePaths = wasm?.wasmPaths;
if (remotePaths?.mjs && remotePaths?.wasm) {
  const fileName = (url) => String(url).split("/").pop();
  if (Capacitor.isNativePlatform()) {
    wasm.wasmPaths = {
      mjs: `${BASE_URL}ort/ort-wasm-simd-threaded.mjs`,
      wasm: `${BASE_URL}ort/ort-wasm-simd-threaded.wasm`,
    };
  } else {
    wasm.wasmPaths = {
      mjs: `${BASE_URL}ort/${fileName(remotePaths.mjs)}`,
      wasm: `${BASE_URL}ort/${fileName(remotePaths.wasm)}`,
    };
  }
}
wasm.numThreads = 1;

const SESSION_OPTIONS = {
  enableCpuMemArena: false,
  enableMemPattern: false,
};

const MODEL_ID = "Xenova/opus-mt-zh-en";

let translatorPromise;

export function loadTranslator(onProgress) {
  if (!translatorPromise) {
    translatorPromise = pipeline("translation", MODEL_ID, {
      dtype: "int8",
      device: "wasm",
      session_options: SESSION_OPTIONS,
      progress_callback: onProgress,
    });
  }
  return translatorPromise;
}

export async function translateZhToEn(text) {
  const translator = await loadTranslator();
  const output = await translator(text, { max_new_tokens: 128, num_beams: 2 });
  const first = Array.isArray(output) ? output[0] : output;
  const english = first?.translation_text?.trim();
  if (!english) throw new Error("没有得到英文译文");
  return english;
}
