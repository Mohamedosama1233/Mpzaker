const { redis } = require("./_redis.js");

function toObj(arr) {
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

module.exports = async (req, res) => {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass || req.headers["x-admin-password"] !== pass) {
    return res.status(401).json({ error: "unauthorized" });
  }
  let out;
  try {
    out = await redis([["HGETALL", "msgs"], ["HGETALL", "last"], ["HGETALL", "names"], ["HGETALL", "subjects"]]);
  } catch (e) {
    return res.status(502).json({ error: "redis_failed" });
  }
  if (!out) return res.status(200).json({ configured: false, users: [] });

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
  return res.status(200).json({ configured: true, users });
};
