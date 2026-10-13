# 中译英朗读

离线把中文翻译成英文，标出音标，并用手机系统语音朗读英文。应用包名 `local.myenglish.reader`。

源仓库在 Cursor Origin：`cc-s-team/my-english`，同步时的提交是 `2eb9b194edfc4077d3abc2d1b093aeb8a0f7f475`。工程之后又在本地改过朗读、模型和 Android 构建脚本。

## 技术框架

界面是 Vite 8 的网页，用 Capacitor 8 打进 Android WebView。翻译在手机本地完成，不走网络接口。Android APK 当前使用 int8 ONNX 模型，以降低 MTK 设备的内存峰值。

| 部分 | 实现 |
| --- | --- |
| 翻译 | `@huggingface/transformers`，模型 `Xenova/opus-mt-zh-en`，int8 ONNX，WASM |
| 音标 | CMUdict 转 IPA，见 `src/ipa.js`，词典在 `public/dict/ipa.json` |
| 单词释义 | 本地 ECDICT 英汉词典，见 `src/gloss.js`，词典在 `public/dict/zh.json` |
| 朗读 | Android 使用系统 `TextToSpeech`，经自写插件 `NativeTts`；浏览器里才用 `speechSynthesis` |
| 离线缓存 | 网页版使用 `vite-plugin-pwa`；Android APK 关闭 Service Worker 和浏览器缓存，模型、词典直接打进安装包 |
| Android | Capacitor，`minSdk 24`，`compileSdk/targetSdk 36`，Java 21，Gradle 8.14.3 |

主要文件：

- `src/translate.js`：加载模型并翻译
- `src/ipa.js`：音标
- `src/gloss.js`：查询单词中文释义，支持常见复数、过去式和进行时形式
- `src/speak.js`：朗读入口。Android 上走 `NativeTts`
- `src/main.js`：页面。朗读失败会写到状态栏
- `src/native-runtime.js`：Android 启动时清理旧版 Service Worker、Cache 和 IndexedDB
- `android/app/src/main/java/local/myenglish/reader/NativeTtsPlugin.java`：系统语音插件
- `android/app/src/main/java/local/myenglish/reader/MainActivity.java`：在 `super.onCreate` 之前注册插件
- `scripts/fetch-model.mjs`：下载模型、音标词典和 ECDICT 英汉词典。Hugging Face 失败改 `hf-mirror.com`，音标词典 GitHub 失败改 jsDelivr
- `scripts/build-apk.mjs`：在本机找 JDK 和 Android SDK，执行 `./gradlew assembleDebug`，再 `adb install -r`

模型和词典不在 git 里，由 `npm run fetch-assets` 生成到 `public/models/` 和 `public/dict/`。运行时不需要联网查询释义。

Android 模型文件为 int8 版本：

- `onnx/encoder_model_int8.onnx`，约 50MB
- `onnx/decoder_model_merged_int8.onnx`，约 57MB

## 网页版部署（GitHub Pages）

网页版免费托管在 GitHub Pages，iPad/手机浏览器直接打开即用，不依赖电脑：

**线上地址**：https://lyndonguo88.github.io/my-english/

部署方式是**本机构建 + 用 token 走 GitHub API 推 `gh-pages` 分支**（不用 GitHub Actions：本机网络到 github.com 的 git 推送不通，且 token 只有 `repo` 权限、没有 `workflow` 权限）。全部逻辑在 `scripts/deploy-pages.mjs`：

```powershell
$env:GH_TOKEN="ghp_xxx"; $env:NODE_BIN="tools/node/node.exe"; $env:GIT_BIN="tools/git/cmd/git.exe"
node scripts/deploy-pages.mjs               # 构建 + 切片 + 推送 + 开启 Pages + 验证
node scripts/deploy-pages.mjs --local       # 只构建+切片，供本地 vite preview 验证
node scripts/deploy-pages.mjs --skip-build  # 复用现有 dist 直接推送
node scripts/deploy-pages.mjs --status      # 查看 Pages 和分支状态
```

源码同步到 `main` 分支用 `scripts/sync-github.mjs`（同样走 API）。两个脚本共用 `scripts/gh-lib.mjs`（GitHub Git Data API 封装）。`scripts/verify-live.mjs` 可从公网侧复核分片完整性与 SW 配置。

子路径部署：Pages 项目站点挂在 `/仓库名/` 下，构建时由 `VITE_BASE=/my-english/` 注入 `vite.config.js` 的 `base`，运行时素材路径统一用 `import.meta.env.BASE_URL` 拼接。

### 模型为什么要切片

翻译模型共 113MB（encoder 50MB + decoder 57MB），但：

- GitHub 的 Data/Contents API 单文件上限约 25MB，整份模型推不上去；
- 本机到 github.com 的 `git push` 不通，没法用 Git LFS 或普通推送；
- 国内镜像 `hf-mirror.com` 虽然快，但浏览器跨域拉模型会被 CORS 挡（`net::ERR_FAILED`）。

所以部署脚本把 `models/` 下超过 4MB 的文件切成 ≤4MB 的分片（`xxx.onnx.part0/1/…`）分别推送，并生成 `models/chunk-manifest.json` 记录每个文件的分片数。运行时 `src/model-chunks.js` 给 `fetch` 打补丁：命中清单里的模型文件时，改为**串行**逐片从同源下载、在内存拼成完整 Blob 再返回，对 transformers.js 透明（transformers 内部用自己的 `env.fetch`，所以 `translate.js` 里显式把补丁赋给 `env.fetch`）。

切小片 + 串行 + 每片重试，是为了适配 github.io 在国内的慢下载：单片几十秒内下完，不会撞上浏览器/Service Worker 对单个 fetch 约 300s 的时长上限；拼好的模型按 URL 去重，避免 transformers 对 seq2seq 模型重复请求导致流量翻倍。

首次打开需联网下载约 113MB 模型（视网速约几分钟，状态栏会显示“正在下载模型 xxx（分片 i/N）”），之后由 transformers 的浏览器缓存 + Service Worker 缓存，可断网使用。若之前访问过旧版本，第一次可能需要硬刷新（Ctrl+Shift+R）让新 Service Worker 接管。

> ⚠️ 部署用的 token 有仓库写权限，部署完成后应到 GitHub 设置里撤销或更换，避免泄露。

### 常用命令（npm 脚本）

| 命令 | 作用 |
| --- | --- |
| `npm run fetch-assets` | 下载模型、音标词典、ECDICT 到 `public/`（由 `scripts/fetch-model.mjs` 完成） |
| `npm run dev` | 先 fetch-assets 再起 Vite 开发服务器（`--host`，手机可经局域网访问） |
| `npm run build` | fetch-assets + 网页生产构建到 `dist/`（根路径，本地预览用） |
| `npm run preview` | 起 `vite preview --host` 验证 `dist/` |
| `npm run apk` | 打 Android debug APK 并 `adb install`（见下文） |
| 网页上线 | `node scripts/deploy-pages.mjs`（构建 + 切片 + 推 `gh-pages`，见上） |

### Windows 本机的便携工具

网页部署改动在 Windows 上完成。本机没有全局 Node/Git，用仓库内的便携版（都在 `.gitignore` 里、不进仓库）：

- Node：`tools\node\node.exe`（便携版）；Git：`tools\git\cmd\git.exe`（MinGit）
- 部署脚本靠环境变量找到它们：`$env:NODE_BIN="tools/node/node.exe"; $env:GIT_BIN="tools/git/cmd/git.exe"`
- `.git/config` 来自 Linux（`filemode=true`），跑 git 命令统一加 `-c core.filemode=false`，避免整仓误报修改
- PowerShell 不支持 `&&` 作语句分隔符，多条命令用 `;`

### 改模型 / 改分片时的同步清单

分片机制有几处强耦合，改一处必须同步改其余，否则线上模型会损坏或流量翻倍：

- `scripts/deploy-pages.mjs` 的 `CHUNK_SIZE` 与 `src/model-chunks.js` 的运行时拼接是同一约定的两侧：只改切片大小不改拼接，`chunk-manifest.json` 记录的分片数会和实际文件对不上。
- 换了分片粒度或数量，必须把 `vite.config.js` 里 workbox 的 `cacheName`（现为 `translation-model-v2`）**升一个版本名**作废旧缓存；`chunk-manifest.json` 的策略要保持 `NetworkFirst`，否则旧缓存里的清单会让运行时只下到部分分片、拼出不完整模型。
- `translate.js` 里 `env.fetch = patchedFetch` 不能省：transformers.js 在模块加载时就把当时的 `globalThis.fetch` 绑成了自己的 `env.fetch`，只覆盖 `globalThis.fetch` 是否生效取决于打包求值顺序，必须显式赋值。
- 拼好的 Blob 按 URL 去重不能省：seq2seq 模型会对同一文件发起两次取回，不去重首次流量会从 113MB 翻到 226MB。

### 上线前本地验证 / 上线后复核

- 上线前：`node scripts/deploy-pages.mjs --local` 只构建 + 切片写回 `dist/`，再起 `npm run preview` 在浏览器验证分片拼接、翻译、进度与去重（Network 面板里每片应恰好请求一次）。
- 上线后：`node scripts/verify-live.mjs` 从公网侧复核——所有分片在线、样本字节与本地一致、`sw.js` 缓存策略正确、`index.html` 引用的 JS bundle 与本地构建一致。**判定“新版是否生效”要看这个 bundle 哈希，而不是只看 `index.html` 是否 200**，因为 Pages 有 1–3 分钟 CDN 传播延迟。脚本里 `base` 和样本路径是写死的，换仓库名或改分片后要相应更新，且要先跑过 deploy（依赖 `dist/models/chunk-manifest.json`）。

## 当前 Linux 电脑上的工具

- Node v24、npm 11。`npm install` 走 `https://registry.npmmirror.com`，官方源会卡住
- JDK：`/data2/my/jdk/jdk-21.0.8+9`
- Android SDK：`/data2/my/android-sdk`（platform 36，Build-Tools 35.0.0）
- adb：系统 PATH 中的 `adb`
- `android/local.properties` 指向上述 SDK
- `android/gradle.properties` 里不要写旧机器的 `org.gradle.java.home=/data2/my/jdk/...`
- `android/gradle/wrapper/gradle-wrapper.properties` 使用腾讯 Gradle 镜像。`services.gradle.org` 在这台电脑上会超时

重新打包并安装：

```bash
export PATH="$HOME/.local/node/node-v22.21.0-linux-x64/bin:$PATH"
export JAVA_HOME="/data2/my/jdk/jdk-21.0.8+9"
export ANDROID_HOME="/data2/my/android-sdk"
npm run apk
```

`npm run apk` 会下载素材、构建网页、`cap sync android`、打 debug APK 并安装到当前连接的手机。安装包路径：

`android/app/build/outputs/apk/debug/app-debug.apk`

小米需要打开开发者选项里的 **USB 调试** 和 **USB 安装**，否则 `adb install` 会报 `INSTALL_FAILED_USER_RESTRICTED`。

也可以手动安装：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p local.myenglish.reader -c android.intent.category.LAUNCHER 1
```

## Android 闪退和内存问题

MTK Android 13 设备曾在加载 q4 模型时出现：

```text
can not create a session. failed to allocate a buffer of size 146245277
```

因此 Android APK 已从 q4 改为 int8，并设置 `android:largeHeap="true"`。版本 1.3 还关闭了 Service Worker、浏览器模型缓存和 WASM 缓存，并清理旧版 Service Worker、Cache 与 IndexedDB，避免模型重复占用内存。版本 1.4 增加了本地英汉词典，词典约 4MB。

如果模型加载完成后仍然闪退，先卸载旧版再安装新版：

```bash
adb uninstall local.myenglish.reader
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

## 朗读问题：已经确认的原因

现象是装上以后没有声音。查过两台手机：蔚来 N2401 上没有任何 TTS 引擎；小米 13 Ultra（`2304FPN6DC`，`ishtar`）上有小米语音引擎 `com.xiaomi.mibrain.speech`，默认语言 `en_US`。

代码和系统上实际碰到的点：

1. **应用看不见语音引擎。** Android 11 起，未声明的话 `TextToSpeech` 初始化失败，界面只显示「手机语音还没准备好」。已在 `AndroidManifest.xml` 加上 `android.intent.action.TTS_SERVICE` 的 `<queries>`。引擎服务名是 `com.xiaomi.mibrain.speech.tts.TtsService`。
2. **停朗读和开始朗读抢同一条回调。** `stop()` 的 `onStop` 会落到下一次朗读的监听器上，调用立刻成功返回，声音却没播。现在按 utterance id 过滤；`onError` 会 reject「朗读失败」，不再当成成功。
3. **错误被吃掉。** `prepare()` 失败原来被 `catch` 掉，按钮也没有 `await`。现在启动时和点朗读时都会把错误写到状态栏。
4. **引擎里可能没有英语语音。** 设置里「首选引擎有名字」只说明装了引擎。`NativeTtsPlugin.applyEnglish()` 会找已安装的 `en` / `en-US` voice；没有则提示当前引擎包名。小米引擎要在 **设置 → 更多设置 → 无障碍 → 文字转语音 → 引擎齿轮** 里下载英语，并用该页的播放按钮试听。媒体音量为 0 或静音时也没有声音。
5. **自定义 `AudioAttributes` 在部分国产引擎上会没声。** 已去掉，改由系统引擎自己选音频通道，并设置 `KEY_PARAM_VOLUME`。

`prepare()` 会等引擎 `onInit` 最多 4 秒。初始化失败仍显示「手机语音还没准备好」。

## 单词点击和中文释义

翻译完成后，英文结果中的每个单词都可以单独点击：

1. 下方释义区域显示该单词的中文意思。
2. 同时用英文朗读这个单词。
3. 单词朗读使用顶部当前选择的语速档位，包括「快、中、慢、超慢、更慢、最慢」。
4. 整句朗读期间单词按钮会暂时禁用；点「停止」后可以重新点击。

释义来自打包在 APK 内的 ECDICT 子集，不依赖网络。词典中没有的词会显示「词典里没有这个词」。

## 本地和上游不完全一致的地方

这些是为了本地环境能编过，不要当成上游原文件：

- `scripts/build-apk.mjs` 是本地 Linux 构建脚本
- `android/gradle.properties` 固定使用本机 JDK 21
- `android/app/src/main/res/values/colors.xml` 是本地补的，`styles.xml` 引用了 `@color/colorPrimary` 等，仓库树里没有这个文件
- 启动图标和 `drawable/splash.png` 是占位图，不是各密度的原图
- 没有 `package-lock.json`，依赖以这次 `npm install` 的结果为准
