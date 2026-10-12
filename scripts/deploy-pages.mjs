// 本机构建网页版，把 dist 产物推到 gh-pages 分支，并让 Pages 指向它。
//
// 为什么不用 GitHub Actions：
//   写 .github/workflows/ 需要 token 带 workflow 权限，且 github.com 网页在本机不可达，
//   无法创建/查看工作流。本脚本只用 repo 权限的 token，走 api.github.com 完成全部动作。
//
// 用法：
//   $env:GH_TOKEN="ghp_xxx"; $env:NODE_BIN="tools/node/node.exe"; $env:GIT_BIN="tools/git/cmd/git.exe"
//   node scripts/deploy-pages.mjs              # 构建 + 推送 + 开启 Pages + 验证
//   node scripts/deploy-pages.mjs --skip-build # 用现有 dist 直接推送
//   node scripts/deploy-pages.mjs --status     # 只看状态
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repo, api, readRef, readRemoteTree, uploadEntries, commitTree, showStatus } from "./gh-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const git = process.env.GIT_BIN || "git";
const node = process.env.NODE_BIN || process.execPath;
const branch = process.env.GH_PAGES_BRANCH || "gh-pages";
const owner = repo.split("/")[0];
const siteName = repo.split("/")[1];
const base = `/${siteName}/`;
const dist = path.join(root, "dist");
const url = `https://${owner.toLowerCase()}.github.io${base}`;

if (process.argv.includes("--status")) {
  await showStatus(branch);
  console.log(`线上地址：${url}`);
  process.exit(0);
}

// 1. 构建。子路径由 VITE_BASE 决定，Pages 项目站点必须带仓库名前缀。
if (!process.argv.includes("--skip-build")) {
  console.log(`构建网页版（base=${base}）…`);
  const build = spawnSync(node, [path.join(root, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_BASE: base, CAPACITOR_BUILD: "" },
  });
  if (build.status !== 0) throw new Error("构建失败");
}
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("dist/index.html 不存在，先构建");

// 2. 把 dist/models 下超过 CHUNK_SIZE 的大文件切成 .partN 写回磁盘，并生成分片清单。
//   Data/Contents API 单文件上限约 25MB（实测 25.6MB 可过、50MB+ 报 422），翻译模型的
//   onnx 有 50~57MB 推不上去；切好后 dist 布局与线上一致，可先本地 preview 验证再推送。
//   片切得小（4MB）是为了适配 github.io 在国内的慢下载：单片几十秒内下完，
//   不会撞上浏览器/SW 对单个 fetch 约 300s 的时长上限（详见 src/model-chunks.js）。
//   只切 models/；ort/ 的 wasm（25.6MB）保持原名（onnxruntime 直接按名加载，不能改）。
const CHUNK_SIZE = 4 * 1024 * 1024;

function chunkDistOnDisk() {
  const modelsDir = path.join(dist, "models");
  if (!fs.existsSync(modelsDir)) return;
  const big = [];
  (function scan(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) scan(full);
      else if (fs.statSync(full).size > CHUNK_SIZE) big.push(full);
    }
  })(modelsDir);
  const manifest = {};
  for (const full of big) {
    const rel = path.relative(dist, full).split(path.sep).join("/");
    const bytes = fs.readFileSync(full);
    const parts = Math.ceil(bytes.length / CHUNK_SIZE);
    manifest[rel] = parts;
    for (let i = 0; i < parts; i += 1) {
      fs.writeFileSync(`${full}.part${i}`, bytes.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, bytes.length)));
    }
    fs.rmSync(full);
    console.log(`  ✂ ${rel}（${(bytes.length / 1048576).toFixed(1)}MB）→ ${parts} 片`);
  }
  if (Object.keys(manifest).length > 0) {
    fs.writeFileSync(path.join(modelsDir, "chunk-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`  清单 models/chunk-manifest.json：${JSON.stringify(manifest)}`);
  }
}

chunkDistOnDisk();

// --local：只构建+切片，不推送，供本地 vite preview 验证分片拼接是否可用。
if (process.argv.includes("--local")) {
  console.log(`\ndist 已按线上布局切好分片，本地验证（注意 preview 也要带 VITE_BASE）：`);
  console.log(`  $env:VITE_BASE='${base}'; & ${node} node_modules/vite/bin/vite.js preview --port 4173`);
  console.log(`  浏览器打开 http://localhost:4173${base}`);
  process.exit(0);
}

// 3. 收集产物（dist 已切好分片），用 git hash-object 算出与远端一致的 blob 哈希。
//   字节从标准输入喂给 git：磁盘产物和上传内容完全一致，不存在 CRLF 归一化差异。
function hashBytes(bytes, label) {
  const result = spawnSync(git, ["-C", root, "hash-object", "-w", "--stdin"], { input: bytes, encoding: "utf8" });
  const sha = result.stdout?.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(sha || "")) {
    throw new Error(`计算哈希失败 ${label}：${result.stderr || result.stdout}`);
  }
  return sha;
}

const files = [];
(function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);

const entries = files.map((full) => {
  const rel = path.relative(dist, full).split(path.sep).join("/");
  const bytes = fs.readFileSync(full);
  return { path: rel, mode: "100644", sha: hashBytes(bytes, rel), size: bytes.length, content: () => bytes.toString("base64") };
});
const total = entries.reduce((sum, entry) => sum + entry.size, 0);
console.log(`产物 ${entries.length} 个文件，共 ${(total / 1048576).toFixed(1)}MB`);

// 4. 只上传内容变过的文件（命中远端就跳过），再整体替换 gh-pages 树
const currentRef = await readRef(branch);
const parent = currentRef?.object.sha || null;
const remoteTree = await readRemoteTree(parent);
console.log(parent ? `gh-pages 现有提交 ${parent.slice(0, 7)}，比对差异…` : "gh-pages 分支不存在，首次全量推送…");
await uploadEntries(entries, remoteTree, (entry) => entry.content());

const message = process.env.GH_MESSAGE || `deploy: 发布网页版（${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC）`;
const sha = await commitTree(branch, entries, { parent, message });
console.log(`已推送产物 ${sha.slice(0, 7)} 到 ${branch}`);

// 5. 把 Pages 指向 gh-pages 根目录（repo 权限即可，不需要 workflow）
for (const method of ["POST", "PUT"]) {
  try {
    const site = await api(method, `/repos/${repo}/pages`, { source: { branch, path: "/" } });
    console.log(site ? `Pages 已设置（${method}）：${site.html_url} 状态 ${site.status}` : `Pages 已设置（${method}，无返回体）`);
    break;
  } catch (error) {
    console.log(`${method} 设置 Pages：${error.status === 409 ? "已存在，改用另一种方法" : error.message}`);
  }
}

// 6. 等站点上线并抽查关键资源
for (let attempt = 1; attempt <= 18; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10000));
  try {
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (response.status !== 200) {
      console.log(`第 ${attempt} 次：HTTP ${response.status}`);
      continue;
    }
    console.log(`站点已上线（第 ${attempt} 次探测）：${url}`);
    for (const asset of ["manifest.webmanifest", "sw.js"]) {
      const probe = await fetch(`${url}${asset}`, { cache: "no-store" });
      console.log(`  ${probe.status === 200 ? "✓" : "✗"} ${asset} → HTTP ${probe.status} ${probe.headers.get("content-type") || ""}`);
    }
    break;
  } catch (error) {
    console.log(`第 ${attempt} 次未就绪：${error.message}`);
  }
}
console.log(`iPad 浏览器直接打开：${url}`);
