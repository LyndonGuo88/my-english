let glossPromise;

export function loadGloss() {
  if (!glossPromise) {
    glossPromise = fetch(`${import.meta.env.BASE_URL}dict/zh.json`).then((response) => {
      if (!response.ok) throw new Error("中文释义词典加载失败");
      return response.json();
    });
  }
  return glossPromise;
}

function candidates(word) {
  const key = word.toLowerCase();
  const list = [key];
  if (key.endsWith("'s")) list.push(key.slice(0, -2));
  if (key.endsWith("ies")) list.push(`${key.slice(0, -3)}y`);
  if (key.endsWith("es")) list.push(key.slice(0, -2));
  if (key.endsWith("s")) list.push(key.slice(0, -1));
  if (key.endsWith("ing")) list.push(key.slice(0, -3), `${key.slice(0, -3)}e`);
  if (key.endsWith("ed")) list.push(key.slice(0, -2), key.slice(0, -1));
  return [...new Set(list.filter(Boolean))];
}

export async function lookupGloss(word) {
  const dict = await loadGloss();
  for (const key of candidates(word)) {
    if (dict[key]) return dict[key];
  }
  return "";
}
