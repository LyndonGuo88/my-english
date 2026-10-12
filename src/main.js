import { Capacitor } from "@capacitor/core";
import { registerSW } from "virtual:pwa-register";
import { prepareNativeRuntime } from "./native-runtime.js";
import { loadGloss, lookupGloss } from "./gloss.js";
import { annotate, loadDictionary } from "./ipa.js";
import { prepareVoices, speakEnglish, stopSpeaking } from "./speak.js";
import { loadTranslator, translateZhToEn } from "./translate.js";

const source = document.querySelector("#source");
const translateButton = document.querySelector("#translate");
const status = document.querySelector("#status");
const result = document.querySelector("#result");
const words = document.querySelector("#words");
const glossWord = document.querySelector("#gloss-word");
const glossMeaning = document.querySelector("#gloss-meaning");
const speakButton = document.querySelector("#speak");
const stopButton = document.querySelector("#stop");
const speedButtons = [...document.querySelectorAll(".speeds button")];

let english = "";
let rate = 1;
let ready = false;
let speaking = false;

function setStatus(message) {
  status.textContent = message;
}

function render(tokens) {
  words.replaceChildren();
  for (const token of tokens) {
    if (!token.ipa) {
      const plain = document.createElement("span");
      plain.textContent = token.text;
      words.append(plain);
      continue;
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "word";
    item.disabled = speaking;
    const surface = document.createElement("b");
    surface.textContent = token.text;
    const ipa = document.createElement("span");
    ipa.textContent = token.ipa;
    item.append(surface, ipa);
    item.addEventListener("click", () => selectWord(item, token.text));
    words.append(item);
  }
  result.hidden = false;
}

function setWordsEnabled(enabled) {
  for (const item of words.querySelectorAll("button.word")) {
    item.disabled = !enabled;
  }
}

function resetGloss() {
  glossWord.textContent = "点一个单词";
  glossMeaning.textContent = "这里显示它的中文意思。";
  for (const item of words.querySelectorAll("button.word")) {
    item.setAttribute("aria-pressed", "false");
  }
}

async function selectWord(item, word) {
  if (speaking) {
    setStatus("正在朗读，请等读完或点停止后再点单词。");
    return;
  }
  for (const button of words.querySelectorAll("button.word")) {
    button.setAttribute("aria-pressed", button === item ? "true" : "false");
  }
  glossWord.textContent = word;
  glossMeaning.textContent = "正在查释义…";
  let meaning = "";
  try {
    meaning = await lookupGloss(word);
  } catch (error) {
    glossMeaning.textContent = error.message || "中文释义词典加载失败";
    return;
  }
  glossMeaning.textContent = meaning || "词典里没有这个词";
  speaking = true;
  setWordsEnabled(false);
  try {
    await speakEnglish(word, rate);
  } catch (error) {
    setStatus(error.message || "朗读失败");
  } finally {
    speaking = false;
    setWordsEnabled(true);
  }
}

function onProgress(event) {
  if (!event) return;
  if (event.status === "progress_total") {
    setStatus(`正在加载翻译模型… ${Math.round(event.progress)}%`);
    return;
  }
  if (event.status === "progress" && event.file) {
    setStatus(`正在加载${event.file.split("/").pop()}… ${Math.round(event.progress)}%`);
  }
}

const BASE_URL = import.meta.env.BASE_URL;

async function registerServiceWorker() {
  if (Capacitor.isNativePlatform()) {
    // APK 不需要 Service Worker，模型已在包内。
    return;
  }
  registerSW({ immediate: true });
  if (!navigator.serviceWorker) {
    // 用局域网 IP 走 HTTP 访问时不是安全上下文，没有 Service Worker，
    // 交给翻译器按需从镜像拉模型就行。
    setStatus("正在加载翻译模型，第一次会久一些…");
    return;
  }
  // 模型不再随站点预取（改为首次从镜像拉，由 transformers 缓存）；
  // 只等 SW 就绪，页面自身和词典/运行时由 SW 预缓存。
  setStatus("正在准备，第一次加载模型会久一些…");
  await navigator.serviceWorker.ready;
}

let voiceError = "";
prepareVoices().catch((error) => {
  voiceError = error.message || "手机语音还没准备好";
  setStatus(voiceError);
});

prepareNativeRuntime()
  .then(() => registerServiceWorker())
  .then(() => Promise.all([loadDictionary(), loadGloss()]))
  .then(() => loadTranslator(onProgress))
  .then(() => {
    ready = true;
    translateButton.disabled = false;
    setStatus(voiceError || "模型已加载。这次打开时会缓存到手机，之后可以断网翻译。");
  })
  .catch((error) => {
    const message = String(error?.message || error || "");
    if (/allocate a buffer|out of memory|OOM/i.test(message)) {
      setStatus("内存不足，无法加载翻译模型。请关闭其他应用后重试。");
      return;
    }
    setStatus(message || "模型加载失败");
  });

translateButton.disabled = true;

translateButton.addEventListener("click", async () => {
  const text = source.value.trim();
  if (!text) {
    setStatus("请先输入中文。");
    return;
  }
  if (!ready) {
    setStatus("翻译模型还在加载。");
    return;
  }
  translateButton.disabled = true;
  stopSpeaking();
  setStatus("正在翻译…");
  try {
    english = await translateZhToEn(text);
    render(await annotate(english));
    resetGloss();
    setStatus("翻译完成。点“朗读”听整句，或点单个单词。");
  } catch (error) {
    setStatus(error.message || "翻译失败");
  } finally {
    translateButton.disabled = false;
  }
});

for (const button of speedButtons) {
  button.addEventListener("click", () => {
    rate = Number(button.dataset.rate);
    for (const item of speedButtons) {
      item.setAttribute("aria-pressed", item === button ? "true" : "false");
    }
  });
}

speakButton.addEventListener("click", async () => {
  if (!english) return;
  if (speaking) return;
  speaking = true;
  setWordsEnabled(false);
  try {
    setStatus("正在朗读…");
    await speakEnglish(english, rate);
    setStatus("朗读完成。可以点单个单词。");
  } catch (error) {
    setStatus(error.message || "朗读失败");
  } finally {
    speaking = false;
    setWordsEnabled(true);
  }
});

stopButton.addEventListener("click", () => {
  stopSpeaking();
  speaking = false;
  setWordsEnabled(true);
  setStatus("已停止朗读。");
});
