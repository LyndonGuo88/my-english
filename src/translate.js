import { Capacitor } from "@capacitor/core";
import { env, pipeline } from "@huggingface/transformers";

// 部署到子路径（例如 GitHub Pages 的 /仓库名/）时，素材路径要跟着 base 走。
const BASE_URL = import.meta.env.BASE_URL;
// 网页版不将 107MB 模型随站点分发（本机上传不走），而是首次从国内镜像 huggingface 拉取，
// 拉下后由浏览器 Cache API 缓存，之后可离线。APK 仍用内置本地模型。
const MODEL_HOST = "https://hf-mirror.com/";
const native = Capacitor.isNativePlatform();

env.allowRemoteModels = !native;
env.allowLocalModels = native;
if (native) {
  env.localModelPath = `${BASE_URL}models/`;
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.useCustomCache = false;
} else {
  // 远程模型走镜像；useBrowserCache 把模型文件存进 Cache API，下次/断网直接读缓存。
  env.remoteHost = MODEL_HOST;
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
