// Downloads every Riftbound card from the Riftcodex API (https://riftcodex.com)
// and writes a compact web/cards.json that the game loads.
// Run: node scripts/fetch-cards.mjs
import { writeFile } from "node:fs/promises";

const API = "https://api.riftcodex.com";
const PROMO_SETS = new Set(["PR", "OPP", "JDG"]);

async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    await new Promise(r => setTimeout(r, 1000 * attempt));
  }
}

// Strip variant markers so "Vi - Piltover Enforcer (Signature)" and its alt art collapse to one card.
const baseName = name => name
  .replace(/\s*\(\d+\)/g, "")              // token numbers: "Recruit (271) // Buff"
  .replace(/\s*\((?:[^)]*)\)\s*$/g, "")   // trailing variant tags: "(Signature)"
  .replace(/\s+/g, " ")
  .trim();

// Card text uses symbol codes like ":rb_exhaust:" or ":rb_energy_2::rb_rune_chaos:".
// Turn each run of symbols into words: "6 energy + 2 Chaos power", "Exhaust", "Might".
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function symbolsToWords(run) {
  const codes = [...run.matchAll(/:rb_([a-z0-9_]+):/gi)].map(m => m[1].toLowerCase());
  const parts = [];
  const runes = new Map();
  for (const code of codes) {
    let m;
    if ((m = code.match(/^energy_(\d+)$/))) parts.push(`${m[1]} energy`);
    else if ((m = code.match(/^rune_(\w+)$/))) { const d = m[1] === "rainbow" ? "any" : cap(m[1]); runes.set(d, (runes.get(d) || 0) + 1); }
    else parts.push(cap(code.replace(/_/g, " ")));
  }
  for (const [d, n] of runes) parts.push(`${n} ${d} power`);
  return ` ${parts.join(" + ")} `;
}
const decode = s => s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const cleanText = t => decode((t || "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
  .replace(/<[^>]+>/g, ""))
  .replace(/(?::rb_[a-z0-9_]+:)+/gi, symbolsToWords)
  .replace(/[ \t]+/g, " ")
  .replace(/ ([,.:;)])/g, "$1")
  .replace(/\( /g, "(")
  .replace(/ *\n */g, "\n")
  .trim();

function category(c) {
  const type = c.classification?.type || "Other";
  const sup = c.classification?.supertype || "";
  if (type === "Unit" && /champion/i.test(sup)) return "Champion Unit";
  if (/signature/i.test(sup) && ["Spell", "Unit", "Gear"].includes(type)) return `Signature ${type}`;
  return type;
}

const setsRes = await getJson(`${API}/sets?size=100`);
const sets = setsRes.items
  .map(s => ({ id: s.set_id, name: s.name, released: s.published_on?.slice(0, 10) || null, promo: PROMO_SETS.has(s.set_id) }))
  .sort((a, b) => (a.released || "").localeCompare(b.released || "") || a.name.localeCompare(b.name));

const raw = [];
let page = 1, pages = 1;
do {
  const r = await getJson(`${API}/cards?size=100&page=${page}`);
  raw.push(...r.items);
  pages = r.pages;
  process.stdout.write(`\rpage ${page}/${pages}`);
  page++;
} while (page <= pages);
process.stdout.write("\n");

// One entry per (set, base name). Prefer the non-variant printing for its text.
const byKey = new Map();
for (const c of raw) {
  const set = c.set?.set_id;
  const name = baseName(c.name);
  if (!set || !name) continue;
  if (category(c) === "Rune") continue; // runes are left out of the game
  const key = `${set}|${name.toLowerCase()}`;
  const variant = !!(c.metadata?.alternate_art || c.metadata?.overnumbered || c.metadata?.signature);
  const prev = byKey.get(key);
  if (prev && !prev._variant) {
    if (c.metadata?.signature) prev.signature = true;
    continue;
  }
  byKey.set(key, {
    _variant: variant,
    name,
    set,
    cat: category(c),
    signature: !!c.metadata?.signature || !!prev?.signature,
    domain: c.classification?.domain || [],
    rarity: c.classification?.rarity || null,
    text: cleanText(c.text?.rich || c.text?.plain),
    flavour: cleanText(c.text?.flavour) || null,
    energy: c.attributes?.energy ?? null,
    power: c.attributes?.power ?? null,
    might: c.attributes?.might ?? null,
    tags: c.tags || [],
    num: c.collector_number ?? null,
    artist: c.media?.artist || null,
    img: c.media?.image_url || prev?.img || null,
    wide: c.orientation === "landscape",
  });
}

const cards = [...byKey.values()]
  .map(({ _variant, ...c }) => c)
  .sort((a, b) => a.set.localeCompare(b.set) || a.name.localeCompare(b.name));

const out = {
  source: "Riftcodex API (https://riftcodex.com). Card data © Riot Games.",
  fetched: new Date().toISOString().slice(0, 10),
  sets,
  cards,
};
await writeFile(new URL("../web/cards.json", import.meta.url), JSON.stringify(out));

const counts = {};
for (const c of cards) counts[c.cat] = (counts[c.cat] || 0) + 1;
console.log(`${raw.length} printings -> ${cards.length} cards in ${sets.length} sets`);
console.log(counts);
