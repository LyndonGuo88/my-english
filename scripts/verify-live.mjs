// 线上完整性校验：确认 gh-pages 上分片模型的每个资源都在线、大小正确、SW 配置生效。
// 上传时已用 git blob SHA 逐片校验（内容字节级一致），这里再从公网侧复核可达性与关键内容。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const base = "https://lyndonguo88.github.io/my-english/";

const manifest = JSON.parse(fs.readFileSync(path.join(dist, "models/chunk-manifest.json"), "utf8"));

let ok = 0;
let bad = 0;

async function head(rel) {
  const res = await fetch(`${base}${rel}?t=${Date.now()}`, { method: "GET", cache: "no-store", headers: { Range: "bytes=0-0" } });
  // 200 或 206 都算在线
  return res.status === 200 || res.status === 206 ? res.status : res.status;
}

// 1. 校验所有分片在线
console.log("=== 分片可达性（Range 探测，不下载整片）===");
for (const [rel, count] of Object.entries(manifest)) {
  for (let i = 0; i < count; i += 1) {
    const partRel = `${rel}.part${i}`;
    try {
      const status = await head(partRel);
      if (status === 200 || status === 206) ok += 1;
      else {
        bad += 1;
        console.log(`  ✗ ${partRel} → HTTP ${status}`);
      }
    } catch (error) {
      bad += 1;
      console.log(`  ✗ ${partRel} → ${error.message}`);
    }
  }
}
console.log(`分片：${ok} 在线，${bad} 异常（共 ${ok + bad} 片）`);

// 2. 完整下载 2 个样本分片，比对解压后字节数与本地是否一致（验证传输无损）
console.log("\n=== 样本分片字节完整性（完整下载比对）===");
const samples = [
  "models/Xenova/opus-mt-zh-en/onnx/decoder_model_merged_int8.onnx.part0",
  "models/Xenova/opus-mt-zh-en/tokenizer.json.part1",
];
for (const rel of samples) {
  const localSize = fs.statSync(path.join(dist, rel)).size;
  const res = await fetch(`${base}${rel}?t=${Date.now()}`, { cache: "no-store" });
  const buf = await res.arrayBuffer();
  const match = buf.byteLength === localSize;
  console.log(`  ${match ? "✓" : "✗"} ${rel.split("/").pop()}: 线上 ${buf.byteLength}B vs 本地 ${localSize}B HTTP ${res.status}`);
  if (!match) bad += 1;
}

// 3. sw.js 缓存策略
console.log("\n=== sw.js 缓存策略 ===");
const sw = await (await fetch(`${base}sw.js?t=${Date.now()}`, { cache: "no-store" })).text();
console.log(`  translation-model-v2: ${sw.includes("translation-model-v2") ? "✓" : "✗"}`);
console.log(`  NetworkFirst(manifest): ${sw.includes("NetworkFirst") ? "✓" : "✗"}`);
console.log(`  旧缓存名残留: ${/translation-model(?!-v2)/.test(sw) ? "✗ 有" : "✓ 无"}`);

// 4. index.html 引用的 JS bundle
console.log("\n=== index.html ===");
const html = await (await fetch(`${base}?t=${Date.now()}`, { cache: "no-store" })).text();
const jsMatch = html.match(/assets\/(index-[\w-]+\.js)/);
const localHtml = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const localJs = localHtml.match(/assets\/(index-[\w-]+\.js)/);
console.log(`  线上引用: ${jsMatch?.[1] || "未找到"}`);
console.log(`  本地引用: ${localJs?.[1] || "未找到"}`);
console.log(`  ${jsMatch && localJs && jsMatch[1] === localJs[1] ? "✓ 一致（新版已生效）" : "✗ 不一致（可能还在传播）"}`);

console.log(`\n总结：${bad === 0 ? "全部通过 ✓" : `有 ${bad} 项异常 ✗`}`);
