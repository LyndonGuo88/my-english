import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

function javaFrom(dir) {
  if (!dir || !existsSync(dir)) return "";
  const names = readdirSync(dir).filter((name) => name.startsWith("jdk-21"));
  return names
    .map((name) => path.join(dir, name))
    .find((home) => existsSync(path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java"))) || "";
}

const javaHome =
  (process.env.JAVA_HOME && existsSync(path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"))
    ? process.env.JAVA_HOME
    : "") ||
  javaFrom("D:/work/tools/jdk") ||
  javaFrom("/data2/my/jdk");
if (!javaHome) throw new Error("找不到 JDK 21");

const androidHome = process.env.ANDROID_HOME || (existsSync("D:/work/tools/android-sdk") ? "D:/work/tools/android-sdk" : "/data2/my/android-sdk");
const pathSep = process.platform === "win32" ? ";" : ":";
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  PATH: `${path.join(javaHome, "bin")}${pathSep}${path.join(androidHome, "platform-tools")}${pathSep}${process.env.PATH}`,
};

const gradle = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
execSync(`${gradle} assembleDebug`, {
  cwd: "android",
  env,
  stdio: "inherit",
  shell: true,
});

const apk = "android/app/build/outputs/apk/debug/app-debug.apk";
console.log(`\n安装包: ${apk}`);
try {
  execSync(`adb install -r ${apk}`, { env, stdio: "inherit", shell: true });
  execSync("adb shell monkey -p local.myenglish.reader -c android.intent.category.LAUNCHER 1", {
    env,
    stdio: "inherit",
    shell: true,
  });
} catch (error) {
  console.error("手机未连接时，可稍后执行: adb install -r", apk);
  if (error.status) process.exitCode = error.status;
}
