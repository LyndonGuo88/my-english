import { spawn } from "node:child_process";
import { execSync } from "node:child_process";

const preview = process.argv.includes("--preview");
const port = Number(process.env.PORT) || (preview ? 4173 : 5173);

function run(cmd, args) {
  execSync([cmd, ...args].join(" "), { stdio: "inherit" });
}

run("adb", ["reverse", `tcp:${port}`, `tcp:${port}`]);
console.log(`\n手机 Chrome 打开: http://127.0.0.1:${port}/\n`);

const vite = spawn(
  "npx",
  preview
    ? ["vite", "preview", "--host", "127.0.0.1", "--port", String(port)]
    : ["vite", "--host", "127.0.0.1", "--port", String(port)],
  { stdio: "inherit", shell: true },
);

vite.on("exit", (code) => {
  try {
    execSync(`adb reverse --remove tcp:${port}`, { stdio: "ignore" });
  } catch {
    // ignore
  }
  process.exit(code ?? 0);
});

process.on("SIGINT", () => vite.kill("SIGINT"));
process.on("SIGTERM", () => vite.kill("SIGTERM"));
