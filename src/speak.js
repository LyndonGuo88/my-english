import { Capacitor, registerPlugin } from "@capacitor/core";

const NativeTts = registerPlugin("NativeTts");
const ENGLISH = /^en(-|$)/i;

function useNative() {
  return Capacitor.getPlatform() === "android";
}

function englishVoice() {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  return (
    voices.find((voice) => ENGLISH.test(voice.lang) && voice.localService) ??
    voices.find((voice) => ENGLISH.test(voice.lang)) ??
    null
  );
}

export function prepareVoices() {
  if (useNative()) {
    return NativeTts.prepare();
  }
  if (!window.speechSynthesis) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    window.speechSynthesis.getVoices();
  });
  return Promise.resolve();
}

let turn = 0;

function speakOnce(text, rate, voice) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = rate;
    if (voice) utterance.voice = voice;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function speakPieces(text, rate, say) {
  const mine = ++turn;
  if (rate > 0.3) {
    await say(text, rate);
    return;
  }
  const pieces = text.match(/[A-Za-z0-9']+|[^\sA-Za-z0-9']+/g) ?? [text];
  const gap = rate <= 0.15 ? 1200 : 600;
  for (const piece of pieces) {
    if (mine !== turn) return;
    if (!/[A-Za-z0-9]/.test(piece)) continue;
    await say(piece, rate);
    if (mine !== turn) return;
    await wait(gap);
  }
}

export async function speakEnglish(text, rate) {
  turn += 1;
  if (useNative()) {
    await NativeTts.stop().catch(() => {});
    await speakPieces(text, rate, (piece, pieceRate) => NativeTts.speak({ text: piece, rate: pieceRate }));
    return;
  }
  window.speechSynthesis?.cancel();
  if (!window.speechSynthesis) {
    throw new Error("这台设备的浏览器没有朗读功能");
  }
  const voice = englishVoice();
  await speakPieces(text, rate, (piece, pieceRate) => speakOnce(piece, pieceRate, voice));
}

export function stopSpeaking() {
  turn += 1;
  if (useNative()) {
    NativeTts.stop().catch(() => {});
    return;
  }
  window.speechSynthesis?.cancel();
}
