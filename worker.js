import data from "./data.json";

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

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

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

const LABELS = data.labels.map(norm);
const N = data.chunks.length;

function retrieve(query, subject, limit) {
  if (!N) return [];
  const scores = new Map();
  for (const t of new Set(tokens(query))) {
    if (!has(data.index, t)) continue;
    const ids = data.index[t];
    const idf = Math.log(1 + N / ids.length);
    for (const id of ids) scores.set(id, (scores.get(id) || 0) + idf);
  }
  const subjKey =
    subject && !subject.startsWith("عام")
      ? norm(subject).replace(/^ال/, "").split(/\s+/)[0]
      : "";
  const ranked = [];
  for (const [id, s0] of scores) {
    let s = s0;
    if (subjKey && LABELS[data.chunks[id][0]].includes(subjKey)) s *= 1.5;
    ranked.push([id, s]);
  }
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked.slice(0, limit).map(([id]) => ({
    label: data.labels[data.chunks[id][0]],
    text: data.chunks[id][1],
  }));
}

async function redis(env, commands) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
  const r = await fetch(env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.UPSTASH_REDIS_REST_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error("redis_" + r.status);
  return r.json();
}

async function chat(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.OPENROUTER_API_KEY || !env.MODEL) return json({ error: "server_not_configured" }, 500);

  const raw = await request.text();
  if (raw.length > 4000000) return json({ error: "too_large" }, 413);
  let body = {};
  try { body = JSON.parse(raw) || {}; } catch (e) {}

  const msgs = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const clean = msgs
    .map((m) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String((m && m.content) || "").slice(0, 2000),
    }))
    .filter((m) => m.content);
  if (!clean.length || clean[clean.length - 1].role !== "user") {
    return json({ error: "bad_request" }, 400);
  }

  const grade = String(body.grade || "").slice(0, 60);
  const subject = String(body.subject || "").slice(0, 60);
  const sid = /^[a-z0-9-]{8,40}$/.test(String(body.sid || "")) ? body.sid : "anon";
  const name = String(body.name || "").replace(/[\n\r]/g, " ").slice(0, 30);

  const query = clean.filter((m) => m.role === "user").slice(-2).map((m) => m.content).join(" ");
  const found = retrieve(query, subject, 6);
  const sources = found.length
    ? found.map((c, i) => `[${i + 1}] (${c.label})\n${c.text}`).join("\n\n")
    : "لا توجد مصادر مطابقة للسؤال ده.";

  const system =
    SYSTEM +
    `\n\nالطالب في: ${grade || "الثانوية العامة"}. المادة: ${subject || "عام"}.` +
    `\n\nالمصادر:\n${sources}`;

  const messages = [{ role: "system", content: system }].concat(clean);

  const image = typeof body.image === "string" ? body.image : "";
  if (image) {
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 2500000) {
      return json({ error: "bad_image" }, 400);
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
      headers: { Authorization: "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.MODEL, messages, temperature: 0.3, max_tokens: 700 }),
    });
    if (!r.ok) return json({ error: "upstream_" + r.status }, 502);
    const d = await r.json();
    reply = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  } catch (e) {
    return json({ error: "upstream_failed" }, 502);
  }
  if (!reply) return json({ error: "empty_reply" }, 502);

  const log = redis(env, [
    ["HINCRBY", "msgs", sid, 1],
    ["HSET", "last", sid, String(Date.now())],
    ["HSET", "names", sid, name],
    ["HINCRBY", "subjects", sid + "|" + (subject || "عام"), 1],
  ]).catch(() => null);
  if (ctx && ctx.waitUntil) ctx.waitUntil(log);

  return json({ reply });
}

function toObj(arr) {
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

async function stats(request, env) {
  const pass = env.ADMIN_PASSWORD;
  if (!pass || request.headers.get("x-admin-password") !== pass) {
    return json({ error: "unauthorized" }, 401);
  }
  let out;
  try {
    out = await redis(env, [["HGETALL", "msgs"], ["HGETALL", "last"], ["HGETALL", "names"], ["HGETALL", "subjects"]]);
  } catch (e) {
    return json({ error: "redis_failed" }, 502);
  }
  if (!out) return json({ configured: false, users: [] });

  const msgs = toObj(out[0].result);
  const last = toObj(out[1].result);
  const names = toObj(out[2].result);
  const subj = toObj(out[3].result);

  const users = Object.keys(msgs).map((id) => {
    const subjects = {};
    for (const k of Object.keys(subj)) {
      const [sid, s] = k.split("|");
      if (sid === id) subjects[s] = Number(subj[k]);
    }
    return { id, name: names[id] || "", msgs: Number(msgs[id]), last: Number(last[id] || 0), subjects };
  });
  users.sort((a, b) => b.last - a.last);
  return json({ configured: true, users });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/chat") return chat(request, env, ctx);
    if (pathname === "/api/stats") return stats(request, env);
    return env.ASSETS.fetch(request);
  },
};
