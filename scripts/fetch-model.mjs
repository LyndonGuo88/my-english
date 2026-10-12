import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelDir = path.join(root, "public", "models", "Xenova", "opus-mt-zh-en");
const dictPath = path.join(root, "public", "dict", "ipa.json");
const glossPath = path.join(root, "public", "dict", "zh.json");

const MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_int8.onnx",
  "onnx/decoder_model_merged_int8.onnx",
];

const HF_BASES = [
  "https://huggingface.co/Xenova/opus-mt-zh-en/resolve/main",
  "https://hf-mirror.com/Xenova/opus-mt-zh-en/resolve/main",
];
const CMUDICT_URLS = [
  "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict",
  "https://cdn.jsdelivr.net/gh/cmusphinx/cmudict@master/cmudict.dict",
];
const ECDICT_URL = "https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip";

const VOWELS = new Set([
  "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW",
]);

const PHONE_IPA = {
  AA: "ɑ",
  AE: "æ",
  AH: "ʌ",
  AO: "ɔ",
  AW: "aʊ",
  AY: "aɪ",
  B: "b",
  CH: "tʃ",
  D: "d",
  DH: "ð",
  EH: "ɛ",
  ER: "ɝ",
  EY: "eɪ",
  F: "f",
  G: "ɡ",
  HH: "h",
  IH: "ɪ",
  IY: "i",
  JH: "dʒ",
  K: "k",
  L: "l",
  M: "m",
  N: "n",
  NG: "ŋ",
  OW: "oʊ",
  OY: "ɔɪ",
  P: "p",
  R: "ɹ",
  S: "s",
  SH: "ʃ",
  T: "t",
  TH: "θ",
  UH: "ʊ",
  UW: "u",
  V: "v",
  W: "w",
  Y: "j",
  Z: "z",
  ZH: "ʒ",
};

async function exists(file) {
  try {
    const info = await stat(file);
    return info.size > 0;
  } catch {
    return false;
  }
}

async function download(file, dest) {
  if (await exists(dest)) {
    console.log(`skip ${path.relative(root, dest)}`);
    return;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  let lastError = null;
  for (const base of HF_BASES) {
    const url = `${base}/${file}`;
    console.log(`get  ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        lastError = new Error(`下载失败 ${response.status} ${url}`);
        continue;
      }
      await rm(partial, { force: true });
      await pipeline(response.body, createWriteStream(partial));
      const info = await stat(partial);
      const expected = Number(response.headers.get("content-length"));
      if (expected && info.size !== expected) {
        throw new Error(`文件不完整 ${file}: ${info.size}/${expected}`);
      }
      if (dest.endsWith(".json")) {
        JSON.parse(await readFile(partial, "utf8"));
      }
      await rename(partial, dest);
      console.log(`saved ${path.relative(root, dest)} (${info.size} bytes)`);
      return;
    } catch (error) {
      await rm(partial, { force: true });
      lastError = error;
    }
  }
  throw lastError;
}

function phoneSymbol(phone, stress) {
  if (phone === "AH" && stress === 0) return "ə";
  if (phone === "ER" && stress === 0) return "ɚ";
  const symbol = PHONE_IPA[phone];
  if (!symbol) throw new Error(`未知音素 ${phone}`);
  return symbol;
}

function toSyllables(phones) {
  const nuclei = [];
  phones.forEach((phone, index) => {
    if (VOWELS.has(phone.phone)) nuclei.push(index);
  });
  if (nuclei.length === 0) return [phones];

  const syllables = [];
  let start = 0;
  for (let index = 0; index < nuclei.length; index += 1) {
    const vowel = nuclei[index];
    let end = phones.length;
    if (index < nuclei.length - 1) {
      const gap = nuclei[index + 1] - vowel - 1;
      end = gap <= 1 ? vowel + 1 : vowel + 2;
    }
    syllables.push(phones.slice(start, end));
    start = end;
  }
  return syllables;
}

export function arpabetToIpa(arpabet) {
  const tokens = arpabet.trim().split(/\s+/);
  const comment = tokens.indexOf("#");
  const phones = (comment === -1 ? tokens : tokens.slice(0, comment)).map((token) => {
    const match = token.match(/^([A-Z]+)([012])?$/);
    if (!match) throw new Error(`无法解析音素 ${token}`);
    return { phone: match[1], stress: match[2] ? Number(match[2]) : null };
  });

  let ipa = "";
  for (const syllable of toSyllables(phones)) {
    const stress = syllable.reduce((mark, phone) => {
      if (phone.stress === 1) return "ˈ";
      if (phone.stress === 2 && mark !== "ˈ") return "ˌ";
      return mark;
    }, "");
    ipa += stress;
    for (const phone of syllable) {
      ipa += phoneSymbol(phone.phone, phone.stress);
    }
  }
  return ipa;
}

function buildIpaDict(text) {
  const dict = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith(";;;")) continue;
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const word = line.slice(0, space).toLowerCase();
    if (word.includes("(")) continue;
    const arpabet = line.slice(space + 1).trim();
    try {
      dict[word] = arpabetToIpa(arpabet);
    } catch (error) {
      console.warn(`跳过 ${word}: ${error.message}`);
    }
  }
  return dict;
}

async function fetchGloss() {
  if (await exists(glossPath)) {
    console.log(`skip ${path.relative(root, glossPath)}`);
    return;
  }
  const zipPath = "/tmp/ecdict-sqlite-28.zip";
  await downloadFile(ECDICT_URL, zipPath);
  await mkdir(path.dirname(glossPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", `
import json, re, sqlite3, zipfile
word_re = re.compile(r"^[a-z][a-z'-]*$")
with zipfile.ZipFile(${JSON.stringify(zipPath)}) as zf:
    name = next(n for n in zf.namelist() if n.endswith(".db") or n.endswith(".sqlite"))
    zf.extract(name, "/tmp")
    db_path = "/tmp/" + name
conn = sqlite3.connect(db_path)
rows = conn.execute("""
select word, translation, exchange from stardict
where translation is not null and translation != ''
  and (ifnull(collins,0) > 0 or ifnull(oxford,0) > 0 or ifnull(frq,0) > 0
       or ifnull(tag,'') != '' or (bnc is not null and bnc > 0 and bnc <= 30000))
""")
out = {}
def clean(meaning):
    lines = []
    for line in (meaning or "").splitlines():
        line = line.strip()
        if not line or line.startswith("["):
            continue
        line = re.sub(r"^(?:[a-z]+\\.\\s*)+", "", line)
        if line:
            lines.append(line)
        if len(lines) == 2:
            break
    text = "；".join(lines)
    return text[:80] + "…" if len(text) > 80 else text
for word, meaning, exchange in rows:
    key = (word or "").strip().lower()
    text = clean(meaning or "")
    if word_re.match(key) and text:
        out[key] = text
    for token in (exchange or "").split("/"):
        if ":" not in token:
            continue
        form = token.split(":", 1)[1].strip().lower()
        if word_re.match(form) and text and form not in out:
            out[form] = text
with open(${JSON.stringify(glossPath)}, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print(f"saved gloss {len(out)}")
`], { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`英汉词典生成失败，退出码 ${code}`));
    });
  });
  await rm(zipPath, { force: true });
}

async function downloadFile(url, dest) {
  if (await exists(dest)) return;
  await mkdir(path.dirname(dest), { recursive: true });
  console.log(`get  ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status} ${url}`);
  const partial = `${dest}.part`;
  await rm(partial, { force: true });
  await pipeline(response.body, createWriteStream(partial));
  await rename(partial, dest);
}

async function fetchDictionary() {
  if (await exists(dictPath)) {
    console.log(`skip ${path.relative(root, dictPath)}`);
    return;
  }
  let text = "";
  for (const url of CMUDICT_URLS) {
    console.log(`get  ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      text = await response.text();
      if (text.includes("\nhello ")) break;
      text = "";
    } catch (error) {
      console.warn(`词典下载失败 ${url}: ${error.message}`);
    }
  }
  if (!text.includes("\nhello ")) throw new Error("词典下载失败");
  const dict = buildIpaDict(text);
  await mkdir(path.dirname(dictPath), { recursive: true });
  await writeFile(dictPath, JSON.stringify(dict));
  console.log(`saved ${path.relative(root, dictPath)} (${Object.keys(dict).length} words)`);
}

const samples = {
  "HH AH0 L OW1": "həˈloʊ",
  "K AE1 T": "ˈkæt",
  "AH0 B AW1 T": "əˈbaʊt",
  "AE1 P AH0 L": "ˈæpəl",
  "B AH1 T AH0 N": "ˈbʌtən",
  "W ER1 L D": "ˈwɝld",
};
for (const [arpabet, expected] of Object.entries(samples)) {
  const actual = arpabetToIpa(arpabet);
  if (actual !== expected) {
    throw new Error(`音标转换错误 ${arpabet}: ${actual} !== ${expected}`);
  }
}

await Promise.all([
  ...MODEL_FILES.map((file) => download(file, path.join(modelDir, file))),
  fetchDictionary(),
  fetchGloss(),
]);
