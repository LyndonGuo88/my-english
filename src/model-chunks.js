/**
 * 大模型分片加载：GitHub Data/Contents API 单文件上限约 25MB，而翻译模型的 onnx
 * 有 50~57MB、tokenizer.json 也有 6MB+，无法整份推到 Pages。部署脚本把 models/ 下
 * 超过 CHUNK_SIZE（当前 4MB）的文件切成小分片（xxx.part0/part1/…），并生成
 * models/chunk-manifest.json 记录每个文件的分片数。
 *
 * 这里给 fetch 打补丁：命中清单里的文件时，改为逐片下载同源分片、在内存拼成完整
 * Blob 再返回，对 transformers.js 完全透明。分片同源不触发 CORS。
 *
 * 为什么要切成 4MB 的小片、还要串行下载：
 *   github.io 在国内下载很慢（实测单流几十~几百 KB/s）。若一片太大（如 20MB），
 *   单个请求要下几百秒，会撞上浏览器/Service Worker 对单个 fetch 约 300s 的时长上限
 *   而被掐断（表现为 net::ERR_FAILED / "Failed to fetch"）。小片每片几十秒内下完，
 *   远低于上限；再串行下载，避免 transformers 并行请求 encoder+decoder 时瓜分带宽。
 *   每片还带重试，单片偶发失败不至于让整个模型加载前功尽弃。
 */
const originalFetch = globalThis.fetch.bind(globalThis);

let manifestPromise = null;

function loadManifest() {
  if (!manifestPromise) {
    const base = import.meta.env.BASE_URL;
    manifestPromise = originalFetch(`${base}models/chunk-manifest.json`)
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
  }
  return manifestPromise;
}

// 进度回调：由 main.js 设置，用于在状态栏显示"正在下载模型 xxx 分片 i/N"。
// 分片是内存拼接后整体返回的，transformers 自己的 progress_callback 拿不到下载进度，
// 所以这里单独回报，避免长时间下载时状态栏卡在旧文案、看着像死机。
let progressHandler = null;
export function setChunkProgressHandler(fn) {
  progressHandler = typeof fn === "function" ? fn : null;
}
function report(detail) {
  if (!progressHandler) return;
  try {
    progressHandler(detail);
  } catch {
    // UI 回调异常不能影响下载本身
  }
}

// 串行闸：一次只下载一个模型文件的分片，避免并行瓜分本就紧张的带宽。
let queue = Promise.resolve();
function serialize(task) {
  const result = queue.then(() => task());
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}

const MAX_ATTEMPTS = 3;

// 下载单个分片：流式读取以回报字节进度，失败自动重试（指数退避）。
async function fetchPart(partUrl, label, index, count) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await originalFetch(partUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      if (!res.body) {
        const buf = await res.arrayBuffer();
        report({ file: label, index, count, loaded: buf.byteLength, total: total || buf.byteLength });
        return buf;
      }
      const reader = res.body.getReader();
      const pieces = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pieces.push(value);
        loaded += value.byteLength;
        report({ file: label, index, count, loaded, total });
      }
      const merged = new Uint8Array(loaded);
      let offset = 0;
      for (const piece of pieces) {
        merged.set(piece, offset);
        offset += piece.byteLength;
      }
      return merged.buffer;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw new Error(
    `模型分片下载失败：${label} 第 ${index + 1}/${count} 片（已重试 ${MAX_ATTEMPTS} 次）${lastError?.message ? `：${lastError.message}` : ""}`,
  );
}

// 同一模型文件在一次会话里可能被 transformers 请求不止一次（seq2seq 加载与
// 浏览器缓存写入路径会各取一次），这里把拼好的 Blob 按 URL 记住，重复请求直接复用，
// 避免把上百 MB 的分片重新下载一遍（实测能把首次流量从 ~226MB 砍回 ~113MB）。
const assembled = new Map();

function blobResponse(blob) {
  return new Response(blob, {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(blob.size) },
  });
}

// 把一个模型文件的所有分片按序下载并拼接成单个 Response。
async function reassemble(url, filePath, chunkCount) {
  const label = filePath.split("/").pop();
  const hit = assembled.get(url);
  if (hit) {
    report({ file: label, index: chunkCount, count: chunkCount, loaded: hit.size, total: hit.size, done: true });
    return blobResponse(hit);
  }
  const parts = [];
  let total = 0;
  for (let i = 0; i < chunkCount; i += 1) {
    const buf = await fetchPart(`${url}.part${i}`, label, i, chunkCount);
    total += buf.byteLength;
    parts.push(buf);
  }
  const blob = new Blob(parts, { type: "application/octet-stream" });
  assembled.set(url, blob);
  report({ file: label, index: chunkCount, count: chunkCount, loaded: total, total, done: true });
  return blobResponse(blob);
}

export async function patchedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
  const manifest = await loadManifest();
  const clean = url.split("?")[0];
  for (const [filePath, chunkCount] of Object.entries(manifest)) {
    // 用 /路径 结尾匹配，兼容子路径部署（/my-english/models/…），并避免部分后缀误匹配。
    if (clean.endsWith(`/${filePath}`)) {
      return serialize(() => reassemble(clean, filePath, chunkCount));
    }
  }
  return originalFetch(input, init);
}

// 兜底：直接用 globalThis.fetch 的代码也能命中分片拼接。
// 但 transformers.js 用的是自己的 env.fetch（env.js 加载时就绑定了当时的 globalThis.fetch），
// 所以 translate.js 还会把 patchedFetch 显式赋给 env.fetch，不依赖模块加载顺序。
globalThis.fetch = patchedFetch;
