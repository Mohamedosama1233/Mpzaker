const fs = require("fs");
const path = require("path");
const { redis } = require("./_redis.js");

const SYSTEM = `انت "مذاكر"، مساعد دراسي لطلاب الثانوية العامة في مصر.

قواعد صارمة:
1. جاوب على المعلومات والقوانين والشرح من "المصادر" المرفقة بس. لو الإجابة مش موجودة فيها قول: "مش لاقي ده في المصادر اللي معايا، راجع كتاب المدرسة أو المدرس". متجاوبش من معرفتك العامة.
2. الاستثناء: لو الطالب بعت صورة مسألة، اقرا اللي في الصورة، وحلها بالقوانين والخطوات الموجودة في المصادر بس.
3. اتكلم بالعامية المصرية البسيطة بنبرة صاحب كبير مشجع من غير تعالي.
4. متدّيش الحل جاهز على طول: ابدأ بتلميح أو سؤال، ولو الطالب لسه مش فاهم اشرح خطوة خطوة. وفي المسائل اكتب خطوات الحل كاملة.
5. ردود قصيرة ومناسبة للموبايل، نص عادي من غير ماركداون ولا جداول.
6. متخترعش أرقام صفحات أو أسئلة امتحانات. اذكر اسم المصدر اللي جاوبت منه.
7. متساعدش في الغش جوا الامتحان، ومتطلبش بيانات شخصية.
8. لو الطالب متوتر أو محبط، طمّنه بكلمتين وارجع للمذاكرة بخطوة صغيرة.`;

// ---------- Simple Arabic-aware retrieval over the files in /sources ----------
function norm(s) {
  return String(s)
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}
function tokens(s) {
  return norm(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
}

let CHUNKS = null;
let DF = null;

function loadChunks() {
  if (CHUNKS) return CHUNKS;
  CHUNKS = [];
  DF = new Map();
  const dir = path.join(process.cwd(), "sources");
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { /* no sources folder */ }
  for (const f of files) {
    if (!/\.(txt|md)$/i.test(f) || /^readme/i.test(f)) continue;
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const label = f.replace(/\.(txt|md)$/i, "");
    let buf = "";
    const push = () => {
      const t = buf.trim();
      buf = "";
      if (!t) return;
      const toks = new Set(tokens(t));
      toks.forEach((k) => DF.set(k, (DF.get(k) || 0) + 1));
      CHUNKS.push({ label, nlabel: norm(label), text: t, toks });
    };
    for (const p of text.split(/\n\s*\n/)) {
      if ((buf + p).length > 900) push();
      buf += p + "\n\n";
    }
    push();
  }
  return CHUNKS;
}

function retrieve(query, subject, limit) {
  const chunks = loadChunks();
  if (!chunks.length) return [];
  const q = Array.from(new Set(tokens(query)));
  const N = chunks.length;
  const subjKey = subject && !subject.startsWith("عام")
    ? norm(subject).replace(/^ال/, "").split(/\s+/)[0]
    : "";
  const scored = chunks.map((c) => {
    let s = 0;
    for (const t of q) if (c.toks.has(t)) s += Math.log(1 + N / (DF.get(t) || 1));
    if (s > 0 && subjKey && c.nlabel.includes(subjKey)) s *= 1.5;
    return { c, s };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.c);
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const key = process.env.OPENROUTER_API_KEY;
  const model = process.env.MODEL;
  if (!key || !model) return res.status(500).json({ error: "server_not_configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const msgs = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const clean = msgs
    .map((m) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String((m && m.content) || "").slice(0, 2000),
    }))
    .filter((m) => m.content);
  if (!clean.length || clean[clean.length - 1].role !== "user") {
    return res.status(400).json({ error: "bad_request" });
  }

  const grade = String(body.grade || "").slice(0, 60);
  const subject = String(body.subject || "").slice(0, 60);
  const sid = /^[a-z0-9-]{8,40}$/.test(String(body.sid || "")) ? body.sid : "anon";
  const name = String(body.name || "").replace(/[\n\r]/g, " ").slice(0, 30);

  const query = clean.filter((m) => m.role === "user").slice(-2).map((m) => m.content).join(" ");
  const found = retrieve(query, subject, 6);
  const sources = found.length
    ? found.map((c, i) => `[${i + 1}] (${c.label})\n${c.text.slice(0, 1800)}`).join("\n\n")
    : "لا توجد مصادر مطابقة للسؤال ده.";

  const system =
    SYSTEM +
    `\n\nالطالب في: ${grade || "الثانوية العامة"}. المادة: ${subject || "عام"}.` +
    `\n\nالمصادر:\n${sources}`;

  const messages = [{ role: "system", content: system }].concat(clean);

  const image = typeof body.image === "string" ? body.image : "";
  if (image) {
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 2500000) {
      return res.status(400).json({ error: "bad_image" });
    }
    const last = messages[messages.length - 1];
    last.content = [
      { type: "text", text: last.content },
      { type: "image_url", image_url: { url: image } },
    ];
  }

  let reply;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 700 }),
    });
    if (!r.ok) return res.status(502).json({ error: "upstream_" + r.status });
    const data = await r.json();
    reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  } catch (e) {
    return res.status(502).json({ error: "upstream_failed" });
  }
  if (!reply) return res.status(502).json({ error: "empty_reply" });

  // Usage counts only (no question text is stored).
  try {
    const subjectKey = subject || "عام";
    await redis([
      ["HINCRBY", "msgs", sid, 1],
      ["HSET", "last", sid, String(Date.now())],
      ["HSET", "names", sid, name],
      ["HINCRBY", "subjects", sid + "|" + subjectKey, 1],
    ]);
  } catch (e) { /* stats are optional */ }

  return res.status(200).json({ reply });
};
