const fs = require("fs");
const path = require("path");

function norm(s) {
  return String(s)
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}
function tokens(s) {
  return norm(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
}

const dir = path.join(__dirname, "sources");
let files = [];
try { files = fs.readdirSync(dir).sort(); } catch (e) {}

const labels = [];
const chunks = [];
const index = new Map();

for (const f of files) {
  if (!/\.(txt|md)$/i.test(f) || /^readme/i.test(f)) continue;
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  const li = labels.push(f.replace(/\.(txt|md)$/i, "")) - 1;
  let buf = "";
  const push = () => {
    const t = buf.trim();
    buf = "";
    if (!t) return;
    const id = chunks.push([li, t.slice(0, 1800)]) - 1;
    for (const tk of new Set(tokens(t))) {
      if (!index.has(tk)) index.set(tk, []);
      index.get(tk).push(id);
    }
  };
  for (const p of text.split(/\n\s*\n/)) {
    if ((buf + p).length > 900) push();
    buf += p + "\n\n";
  }
  push();
}

fs.writeFileSync(
  path.join(__dirname, "data.json"),
  JSON.stringify({ labels, chunks, index: Object.fromEntries(index) })
);
console.log("sources indexed: " + labels.length + " files, " + chunks.length + " chunks");
