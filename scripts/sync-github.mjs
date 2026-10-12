// 同步源码和工作区改动到 main 分支（走 GitHub Git Data API）。
//
// 用法：
//   $env:GH_TOKEN="ghp_xxx"; $env:GIT_BIN="tools/git/cmd/git.exe"
//   node scripts/sync-github.mjs            # 同步工作区
//   node scripts/sync-github.mjs --status   # 查看 Pages 和分支状态
//
// token 只从环境变量读取，不写文件、不进仓库。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { api, repo, readRef, readRemoteTree, uploadEntries, commitTree, toEntries, showStatus, isWorkflowPath, pushFileViaContents } from "./gh-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const git = process.env.GIT_BIN || "git";
const branch = process.env.GH_BRANCH || "main";

function gitRun(args) {
  const result = spawnSync(git, ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败：${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// 取字节必须走 git 对象库：git add 会把 CRLF 规范成 LF，索引里的哈希对应 LF，
// 直接读磁盘原字节会得到另一个 blob，哈希校验必然失败。
function blobBase64(entry) {
  const result = spawnSync(git, ["-C", root, "cat-file", "blob", entry.sha], {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`读取 ${entry.path} 失败`);
  return result.stdout.toString("base64");
}

if (process.argv.includes("--status")) {
  await showStatus(branch);
  process.exit(0);
}

// 1. 把工作区全部暂存，用索引反映最新内容，顺便拿到每个文件的模式与哈希
gitRun(["add", "-A"]);
const all = toEntries(gitRun(["ls-files", "-s"]));
// 工作流文件不能走 Data API，单独拿出来用 Contents API 推。
const entries = all.filter((entry) => !isWorkflowPath(entry.path));
const workflows = all.filter((entry) => isWorkflowPath(entry.path));
console.log(`待同步 ${entries.length} 个文件，工流量 ${workflows.length} 个`);

// 2. 读远端状态，内容没变的文件不重复上传
let currentRef = await readRef(branch);
if (!currentRef) {
  // 空仓库不接受 Data API（连建 blob 都返回 409），先用 Contents API 推一个小文件，
  // 把分支和首个提交建出来，后面才能走 blob/tree/commit 流程。
  const seed = entries.find((entry) => entry.path === "README.md") || entries[0];
  await api("PUT", `/repos/${repo}/contents/${seed.path}`, {
    message: "chore: 初始化仓库",
    content: blobBase64(seed),
  });
  currentRef = await readRef(branch);
  console.log(`已用 ${seed.path} 初始化 ${branch} 分支`);
}
const parent = currentRef?.object.sha || null;
const remoteTree = await readRemoteTree(parent);

// 3. 非工作流文件走 Data API，整体替换分支树
await uploadEntries(entries, remoteTree, blobBase64);
const message = process.env.GH_MESSAGE
  || `chore: 同步本机改动（${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC）`;
const sha = await commitTree(branch, entries, { parent, message });
console.log(`已推送提交 ${sha.slice(0, 7)} 到 ${branch}`);

// 4. 工作流文件必须走 Contents API（需要 token 带 workflow 权限），叠在上一个提交之上。
//   当前采用本机构建部署，不用 Actions，无 workflow 权限时只告警不中断。
for (const entry of workflows) {
  if (remoteTree.get(entry.path) === entry.sha) continue;
  try {
    await pushFileViaContents(entry.path, blobBase64(entry), "chore: 更新 Pages 工作流", remoteTree.get(entry.path));
    console.log(`已用 Contents API 写入 ${entry.path}`);
  } catch (error) {
    console.warn(`跳过工作流 ${entry.path}：${error.message}`);
    console.warn("→ 不影响本机构建部署（deploy-pages.mjs）。若要改用 Actions，需把 token 加上 workflow 权限。");
  }
}
console.log("提示：远端提交对象不在本地对象库里，所以不动本地分支指针，每次同步都以工作区为准。");
await showStatus(branch);
