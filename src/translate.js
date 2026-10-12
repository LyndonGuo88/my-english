import { Capacitor } from "@capacitor/core";
import { env, pipeline } from "@huggingface/transformers";

// 部署到子路径（例如 GitHub Pages 的 /仓库名/）时，素材路径要跟着 base 走。
const BASE_URL = import.meta.env.BASE_URL;

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = `${BASE_URL}models/`;

if (Capacitor.isNativePlatform()) {
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.useCustomCache = false;
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
