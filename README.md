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
