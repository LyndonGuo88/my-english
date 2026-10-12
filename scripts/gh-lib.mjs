// GitHub Git Data API 的公共封装，供 sync-github / deploy-pages 共用。
// 只走 api.github.com：github.com 直连在部分网络环境下不可达，
// 而 Data API 只需要 repo 权限的 token，不依赖 SSH 和 git push。
import { spawnSync } from "node:child_process";

const repo = process.env.GH_REPO || "LyndonGuo88/my-english";
const token = process.env.GH_TOKEN;
const author = { name: "LyndonGuo88", email: "gliangzhong@foxmail.com" };

if (!token) throw new Error("缺少 GH_TOKEN 环境变量");

export { repo, author };

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(method, apiPath, body) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (attempt === 3) throw new ApiError(`${method} ${apiPath} 网络失败：${error.message}`, 0);
      const wait = attempt * 2000;
      console.warn(`网络失败，${wait}ms 后重试：${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : null;

    const error = new ApiError(`${method} ${apiPath} -> ${response.status} ${text.slice(0, 200)}`, response.status);
    // 4xx 是请求本身的问题，重试没有意义；只有 5xx 和限流才重试。
    if (response.status < 500 && response.status !== 429) throw error;
    if (attempt === 3) throw error;
    const wait = attempt * 2000;
    console.warn(`服务端 ${response.status}，${wait}ms 后重试`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return null;
}

export function run(command, args, cwd, encoding = "utf8") {
  const result = spawnSync(command, args, { cwd, encoding, maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败：${result.stderr?.toString("utf8") || result.stdout}`);
  }
  return typeof result.stdout === "string" ? result.stdout : Buffer.from(result.stdout);
}

export function toEntries(listed) {
  return listed
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      const [mode, sha] = meta.split(" ");
      return { path: file, mode, sha };
    });
}

// 读取分支当前位置。404 = 分支不存在，409 = 仓库刚建好还是空的。
export async function readRef(branch) {
  try {
    return await api("GET", `/repos/${repo}/git/refs/heads/${branch}`);
  } catch (error) {
    if (error.status === 404 || error.status === 409) return null;
    throw error;
  }
}

export async function readRemoteTree(commitSha) {
  if (!commitSha) return new Map();
  const commit = await api("GET", `/repos/${repo}/git/commits/${commitSha}`);
  const tree = await api("GET", `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  return new Map((tree.tree || []).filter((item) => item.type === "blob").map((item) => [item.path, item.sha]));
}

// 逐个上传内容不同的 blob。makeBase64 由调用方提供（git 对象库或磁盘文件），
// 上百 MB 的模型文件也走这条路径，每个文件单独报进度，避免看着像卡死。
export async function uploadEntries(entries, remoteTree, makeBase64) {
  let uploaded = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (remoteTree.get(entry.path) === entry.sha) continue;
    const started = Date.now();
    const content = makeBase64(entry);
    const size = (Buffer.byteLength(content) / 1048576) * 0.75;
    const blob = await api("POST", `/repos/${repo}/git/blobs`, { content, encoding: "base64" });
    if (blob.sha !== entry.sha) {
      throw new Error(`${entry.path} 哈希不一致：本地 ${entry.sha} 远端 ${blob.sha}`);
    }
    uploaded += 1;
    bytes += size;
    console.log(`  ↑ ${entry.path}（${size.toFixed(1)}MB，${((Date.now() - started) / 1000).toFixed(1)}s）`);
  }
  console.log(`上传变化文件 ${uploaded} 个，共 ${bytes.toFixed(1)}MB`);
  return uploaded;
}

export async function commitTree(branch, entries, { parent, message, baseTree }) {
  const tree = await api("POST", `/repos/${repo}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: entries.map((entry) => ({ path: entry.path, mode: entry.mode, type: "blob", sha: entry.sha })),
  });
  const commit = await api("POST", `/repos/${repo}/git/commits`, {
    message,
    tree: tree.sha,
    parents: parent ? [parent] : [],
    author,
  });
  if (parent) {
    await api("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha });
  } else {
    await api("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  return commit.sha;
}

// .github/workflows/ 下的文件不允许用 Data API 建的 blob 提交（GitHub 的 CI 注入防护），
// 必须走 Contents API，而 Contents API 写工作流需要 token 带 workflow 权限。
export const isWorkflowPath = (p) => p.startsWith(".github/workflows/");

export async function pushFileViaContents(ghPath, base64, message, existingSha) {
  let sha = existingSha;
  if (sha === undefined) {
    try {
      const branch = process.env.GH_BRANCH || "main";
      const existing = await api("GET", `/repos/${repo}/contents/${ghPath}?ref=${branch}`);
      sha = existing?.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const body = { message, content: base64 };
  if (sha) body.sha = sha;
  return api("PUT", `/repos/${repo}/contents/${ghPath}`, body);
}

export async function showStatus(branch) {
  const site = await api("GET", `/repos/${repo}/pages`).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  });
  console.log(site ? `Pages：${site.html_url}（${site.status}，源 ${site.source?.branch}/${site.source?.path}）` : `Pages：尚未开启`);
  try {
    const ref = await readRef(branch);
    console.log(`${branch}：${ref ? ref.object.sha.slice(0, 7) : "空"}`);
  } catch (error) {
    console.log(`${branch}：读取失败 ${error.message}`);
  }
  const releases = await api(`GET`, `/repos/${repo}`).catch(() => null);
  if (releases) console.log(`仓库：${releases.html_url}（${releases.size} KB）`);
}
