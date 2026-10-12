let dictPromise;

export function loadDictionary() {
  if (!dictPromise) {
    dictPromise = fetch(`${import.meta.env.BASE_URL}dict/ipa.json`).then((response) => {
      if (!response.ok) throw new Error("音标词典加载失败");
      return response.json();
    });
  }
  return dictPromise;
}

function lookup(dict, token) {
  const key = token.toLowerCase();
  if (dict[key]) return dict[key];
  const stripped = key.replace(/'/g, "");
  if (dict[stripped]) return dict[stripped];
  if (key.endsWith("'s") && dict[key.slice(0, -2)]) return dict[key.slice(0, -2)];
  return "";
}

export async function annotate(sentence) {
  const dict = await loadDictionary();
  const parts = sentence.match(/[A-Za-z]+(?:'[A-Za-z]+)?|[^A-Za-z]+/g) ?? [];
  return parts.map((text) => {
    if (!/[A-Za-z]/.test(text)) return { text, ipa: "" };
    const ipa = lookup(dict, text);
    return { text, ipa: ipa ? `/${ipa}/` : "无音标" };
  });
}
