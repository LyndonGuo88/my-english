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

// 2. 收集产物，用 git hash-object 算出与远端一致的 blob 哈希。
//   字节从标准输入喂给 git：磁盘产物和上传内容完全一致，不存在 CRLF 归一化差异。
const files = [];
(function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);

// 107MB 模型不随站点推送（Data API 拒绝大 blob），由浏览器首次从 hf-mirror 拉。
// dist/models 仍然会构建时拷进来，但这里不上传它。
const entries = files
  .filter((full) => !path.relative(dist, full).split(path.sep).join("/").startsWith("models/"))
  .map((full) => {
    const rel = path.relative(dist, full).split(path.sep).join("/");
    const bytes = fs.readFileSync(full);
    const result = spawnSync(git, ["-C", root, "hash-object", "-w", "--stdin"], { input: bytes, encoding: "utf8" });
    const sha = result.stdout?.trim();
    if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(sha || "")) {
      throw new Error(`计算哈希失败 ${rel}：${result.stderr || result.stdout}`);
    }
    return { path: rel, mode: "100644", sha, size: bytes.length };
  });
const total = entries.reduce((sum, entry) => sum + entry.size, 0);
console.log(`产物 ${entries.length} 个文件，共 ${(total / 1048576).toFixed(1)}MB`);

// 3. 只上传内容变过的文件（模型命中远端就跳过），再整体替换 gh-pages 树
const currentRef = await readRef(branch);
const parent = currentRef?.object.sha || null;
const remoteTree = await readRemoteTree(parent);
console.log(parent ? `gh-pages 现有提交 ${parent.slice(0, 7)}，比对差异…` : "gh-pages 分支不存在，首次全量推送…");
await uploadEntries(entries, remoteTree, (entry) => fs.readFileSync(path.join(dist, entry.path)).toString("base64"));

const message = process.env.GH_MESSAGE || `deploy: 发布网页版（${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC）`;
const sha = await commitTree(branch, entries, { parent, message });
console.log(`已推送产物 ${sha.slice(0, 7)} 到 ${branch}`);

// 4. 把 Pages 指向 gh-pages 根目录（repo 权限即可，不需要 workflow）
for (const method of ["POST", "PUT"]) {
  try {
    const site = await api(method, `/repos/${repo}/pages`, { source: { branch, path: "/" } });
    console.log(`Pages 已设置（${method}）：${site.html_url} 状态 ${site.status}`);
    break;
  } catch (error) {
    console.log(`${method} 设置 Pages：${error.status === 409 ? "已存在，改用另一种方法" : error.message}`);
  }
}

// 5. 等站点上线并抽查关键资源
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
