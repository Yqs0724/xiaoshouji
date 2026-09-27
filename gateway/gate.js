/**
 * 小屋访问门禁：设定里设密码（哈希存储）+ 可选环境变量 CABIN_GATE。
 * 解锁后发 Cookie；改密后旧 Cookie 失效。
 */
const crypto = require("node:crypto");
const { readSettings, patchSettings } = require("./settings");

const COOKIE_NAME = "cabin_gate";
const MAX_AGE_SEC = 30 * 24 * 3600;

function gateEnvPassword() {
  return String(process.env.CABIN_GATE || "").trim();
}

function gateEnabled(s = readSettings()) {
  if (gateEnvPassword()) return true;
  return !!(s.gate_hash && s.gate_salt);
}

function hashPassword(plain, salt) {
  return crypto.scryptSync(String(plain), String(salt), 32).toString("hex");
}

function timingSafeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a), "hex");
    const bb = Buffer.from(String(b), "hex");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function passwordMatches(plain, s = readSettings()) {
  const p = String(plain || "");
  const env = gateEnvPassword();
  if (env && p === env) return true;
  if (s.gate_hash && s.gate_salt) {
    const h = hashPassword(p, s.gate_salt);
    return timingSafeEqualHex(h, s.gate_hash);
  }
  return false;
}

function tokenSecret(s = readSettings()) {
  if (s.gate_hash) return s.gate_hash;
  const env = gateEnvPassword();
  if (env) return crypto.createHash("sha256").update("cabin:" + env).digest("hex");
  return "";
}

function signUnlockToken(s = readSettings()) {
  const secret = tokenSecret(s);
  if (!secret) return "";
  const exp = Date.now() + MAX_AGE_SEC * 1000;
  const payload = String(exp);
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return payload + "." + sig;
}

function verifyUnlockToken(token, s = readSettings()) {
  const secret = tokenSecret(s);
  if (!secret || !token) return false;
  const parts = String(token).split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expect = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return timingSafeEqualHex(sig, expect);
}

function parseCookies(req) {
  const raw = req.headers && req.headers.cookie;
  const out = Object.create(null);
  if (!raw) return out;
  for (const part of String(raw).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isGateUnlocked(req, s = readSettings()) {
  if (!gateEnabled(s)) return true;
  const tok = parseCookies(req)[COOKIE_NAME];
  return verifyUnlockToken(tok, s);
}

function unlockCookieHeader(token) {
  return (
    COOKIE_NAME +
    "=" +
    encodeURIComponent(token) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
    MAX_AGE_SEC
  );
}

function clearCookieHeader() {
  return COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

/** 设定页：设/清密码。已启用门禁时须已解锁（由调用方保证）。 */
function applyGatePasswordPatch(plain) {
  if (plain == null) return readSettings();
  const p = String(plain);
  if (!p) {
    return patchSettings({ gate_hash: "", gate_salt: "" });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(p, salt);
  return patchSettings({ gate_hash: hash, gate_salt: salt });
}

function gatePublicStatus(req) {
  const s = readSettings();
  const enabled = gateEnabled(s);
  return {
    ok: true,
    enabled,
    unlocked: !enabled || isGateUnlocked(req, s),
    env_override: !!gateEnvPassword(),
  };
}

if (require.main === module) {
  const salt = "test-salt";
  const h = hashPassword("secret", salt);
  console.assert(timingSafeEqualHex(h, hashPassword("secret", salt)));
  console.assert(!timingSafeEqualHex(h, hashPassword("nope", salt)));
  const fake = { gate_hash: h, gate_salt: salt };
  const tok = signUnlockToken(fake);
  console.assert(verifyUnlockToken(tok, fake));
  console.assert(!verifyUnlockToken("0.bad", fake));
  console.log("gate ok");
}

module.exports = {
  gateEnabled,
  passwordMatches,
  isGateUnlocked,
  signUnlockToken,
  unlockCookieHeader,
  clearCookieHeader,
  applyGatePasswordPatch,
  gatePublicStatus,
  COOKIE_NAME,
};
