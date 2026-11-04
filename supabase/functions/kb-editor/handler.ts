// kb-editor handler — the ONLY path by which the Knowledge Base can be changed.
//
//   POST { action: "verify", pin }                                   -> { ok, token, expires_in }
//   POST { action: "save", token, group, content, expected_updated_at, label } -> { ok, updated_at }
//
// * The PIN lives only in Edge Function secrets (EDITOR_PIN or EDITOR_PIN_HASH). It is never sent to the browser.
// * Failed PIN attempts are rate limited per client (salted IP hash) and globally.
// * A correct PIN returns a short-lived HMAC-signed token (kept in browser memory only).
// * Writes use the server-side secret key, back up the previous content first, and are validated (validate.ts).
// * Deploy with verify_jwt = false (see supabase/config.toml): the project uses sb_publishable_ keys, which the
//   platform JWT check does not understand. Authorization is done here, by PIN / token.
import { createClient } from "npm:@supabase/supabase-js@2";
import { validateWrite, MAX_BYTES } from "./validate.ts";

const te = new TextEncoder();
const num = (name: string, def: number) => {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : def;
};

function cfg() {
  return {
    pin: Deno.env.get("EDITOR_PIN") ?? "",
    pinHash: Deno.env.get("EDITOR_PIN_HASH") ?? "",
    tokenSecret: Deno.env.get("EDITOR_TOKEN_SECRET") ?? "",
    allowedOrigins: (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ttl: num("TOKEN_TTL_SECONDS", 1800),
    maxAttempts: num("PIN_MAX_ATTEMPTS", 5),
    windowSecs: num("PIN_WINDOW_SECONDS", 900),
    lockSecs: num("PIN_LOCK_SECONDS", 900),
    globalMax: num("PIN_GLOBAL_MAX_ATTEMPTS", 60),
    globalLockSecs: num("PIN_GLOBAL_LOCK_SECONDS", 300),
    keepBackups: num("BACKUPS_KEEP_PER_GROUP", 200),
  };
}

function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "null");
    if (keys && typeof keys === "object") {
      const k = keys["default"] ?? Object.values(keys)[0];
      if (typeof k === "string" && k) return k;
    }
  } catch { /* fall through to the legacy variable */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

// ---------- small crypto helpers ----------
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string) => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(p); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const sha256 = async (data: string | Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? te.encode(data) : data));
const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, "0")).join("");
function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function hmac(keyBytes: Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(data)));
}

// ---------- PIN ----------
/** pbkdf2-sha256$<iterations>$<salt b64u>$<hash b64u>  (generate with supabase/tools/hash-pin.mjs) */
async function checkPin(pin: string, c: ReturnType<typeof cfg>): Promise<boolean> {
  if (c.pinHash) {
    const [alg, it, salt, hash] = c.pinHash.split("$");
    const iters = Number(it);
    if (alg !== "pbkdf2-sha256" || !iters || !salt || !hash) return false;
    const key = await crypto.subtle.importKey("raw", te.encode(pin), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64u(salt), iterations: iters }, key, 256));
    return safeEqual(bits, unb64u(hash));
  }
  // compare digests (equal length, constant time) instead of the raw strings
  return safeEqual(await sha256("kb-pin|" + pin), await sha256("kb-pin|" + c.pin));
}
const pinConfigured = (c: ReturnType<typeof cfg>) => !!(c.pinHash || c.pin);

// ---------- session token ----------
// Key material includes the PIN secret, so changing the PIN instantly invalidates every outstanding token.
async function tokenKey(c: ReturnType<typeof cfg>) {
  return await sha256("kb-token-v1|" + (c.tokenSecret || serviceKey()) + "|" + (c.pinHash || c.pin));
}
async function issueToken(c: ReturnType<typeof cfg>) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(te.encode(JSON.stringify({ iat: now, exp: now + c.ttl, jti: crypto.randomUUID() })));
  return `v1.${body}.${b64u(await hmac(await tokenKey(c), body))}`;
}
async function tokenState(token: unknown, c: ReturnType<typeof cfg>): Promise<"ok" | "expired" | "invalid"> {
  if (typeof token !== "string") return "invalid";
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return "invalid";
  let sig: Uint8Array; try { sig = unb64u(parts[2]); } catch { return "invalid"; }
  if (!safeEqual(sig, await hmac(await tokenKey(c), parts[1]))) return "invalid";
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(parts[1])));
    return typeof p.exp === "number" && p.exp > Math.floor(Date.now() / 1000) ? "ok" : "expired";
  } catch { return "invalid"; }
}

// ---------- http plumbing ----------
function corsHeaders(req: Request, c: ReturnType<typeof cfg>): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = c.allowedOrigins.length === 0 ? "*" : (c.allowedOrigins.includes(origin) ? origin : c.allowedOrigins[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}
function json(req: Request, c: ReturnType<typeof cfg>, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders(req, c), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

// ---------- handler ----------
export async function handler(req: Request): Promise<Response> {
  const c = cfg();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, c) });
  if (req.method !== "POST") return json(req, c, 405, { ok: false, error: "method_not_allowed" });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = serviceKey();
  if (!url || !key || !pinConfigured(c)) return json(req, c, 503, { ok: false, error: "not_configured" });

  const raw = await req.text();
  if (raw.length > MAX_BYTES + 50_000) return json(req, c, 413, { ok: false, error: "payload_too_large" });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); if (!body || typeof body !== "object") throw 0; } catch { return json(req, c, 400, { ok: false, error: "bad_json" }); }

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const salt = c.tokenSecret || key;
  const ipBucket = "ip:" + hex(await sha256("kb-ip|" + salt + "|" + clientIp(req))).slice(0, 32);

  // ===== verify PIN =====
  if (body.action === "verify") {
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!/^\d{4,8}$/.test(pin)) return json(req, c, 400, { ok: false, error: "bad_format" });

    // 1) refuse while locked (fail closed on any database error)
    let retry = 0;
    for (const b of [ipBucket, "global"]) {
      const { data, error } = await db.rpc("kb_pin_check", { p_bucket: b });
      if (error) return json(req, c, 500, { ok: false, error: "server_error" });
      const r = Array.isArray(data) ? data[0] : data;
      if (r && r.allowed === false) retry = Math.max(retry, Number(r.retry_after) || 1);
    }
    if (retry) return json(req, c, 429, { ok: false, error: "rate_limited", retry_after: retry });

    // 2) count this attempt BEFORE looking at the PIN: if counting fails we stop, so errors can never become a bypass
    const hit = async (bucket: string, max: number, lock: number) => {
      const r = await db.rpc("kb_pin_hit", { p_bucket: bucket, p_max: max, p_window_secs: c.windowSecs, p_lock_secs: lock });
      if (r.error) return null;
      return (Array.isArray(r.data) ? r.data[0] : r.data) as { attempts: number; locked_until: string | null } | null;
    };
    const ipHit = await hit(ipBucket, c.maxAttempts, c.lockSecs);
    const glHit = await hit("global", c.globalMax, c.globalLockSecs);
    if (!ipHit || !glHit) return json(req, c, 500, { ok: false, error: "server_error" });
    for (const h of [ipHit, glHit]) {
      if (h.locked_until) {
        const secs = Math.max(1, Math.ceil((new Date(h.locked_until).getTime() - Date.now()) / 1000));
        return json(req, c, 429, { ok: false, error: "rate_limited", retry_after: secs });
      }
    }

    // 3) check the PIN
    if (await checkPin(pin, c)) {
      await db.rpc("kb_pin_ok", { p_bucket: ipBucket });
      await db.rpc("kb_pin_refund", { p_bucket: "global" });
      return json(req, c, 200, { ok: true, token: await issueToken(c), expires_in: c.ttl });
    }
    return json(req, c, 401, { ok: false, error: "bad_pin", attempts_left: Math.max(0, c.maxAttempts - Number(ipHit.attempts)) });
  }

  // ===== save =====
  if (body.action === "save") {
    const ts = await tokenState(body.token, c);
    if (ts !== "ok") return json(req, c, 401, { ok: false, error: ts === "expired" ? "token_expired" : "token_invalid" });

    const group = typeof body.group === "string" ? body.group : "";
    const expected = body.expected_updated_at === null || body.expected_updated_at === undefined ? null : String(body.expected_updated_at);
    if (expected !== null && Number.isNaN(Date.parse(expected))) return json(req, c, 422, { ok: false, error: "bad_expected_updated_at" });
    const label = typeof body.label === "string" && /^[a-z0-9:_-]{1,60}$/.test(body.label) ? body.label : "edit";

    const cur = await db.from("kb_data").select("content,updated_at").eq("id", group).maybeSingle();
    if (cur.error) return json(req, c, 500, { ok: false, error: "server_error" });
    if (cur.data && (expected === null || Date.parse(cur.data.updated_at) !== Date.parse(expected))) {
      return json(req, c, 409, { ok: false, error: "conflict", current_updated_at: cur.data.updated_at });
    }
    if (!cur.data && expected !== null) return json(req, c, 409, { ok: false, error: "conflict", current_updated_at: null });

    const bad = validateWrite(group, body.content, cur.data ? cur.data.content : null);
    if (bad) return json(req, c, 422, { ok: false, error: "invalid_content", detail: bad });

    const actor = ipBucket.slice(3, 15);
    const w = await db.rpc("kb_apply_write", {
      p_group: group, p_content: body.content, p_expected: cur.data ? cur.data.updated_at : null,
      p_action: label, p_actor: actor, p_keep: c.keepBackups,
    });
    if (w.error) return json(req, c, 500, { ok: false, error: "server_error" });
    const r = Array.isArray(w.data) ? w.data[0] : w.data;
    if (!r || r.status !== "ok") return json(req, c, 409, { ok: false, error: "conflict", current_updated_at: r ? r.row_updated_at : null });
    return json(req, c, 200, { ok: true, updated_at: r.row_updated_at });
  }

  return json(req, c, 400, { ok: false, error: "unknown_action" });
}

