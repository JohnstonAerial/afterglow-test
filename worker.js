/**
 * Afterglow — Push Notification Worker
 * ======================================
 * Two jobs:
 *   1. HTTP endpoints so the app can subscribe/unsubscribe a device for
 *      "N minutes before sunrise/sunset" alerts.
 *   2. A cron trigger (runs every 5 minutes) that checks every stored
 *      subscription against that location's sunrise/sunset time and sends
 *      a Web Push notification when it's time.
 *
 * No npm dependencies — Cloudflare's dashboard "Quick Edit" can't bundle
 * packages, so VAPID signing (RFC 8292) and payload encryption (RFC 8291)
 * are implemented here directly on top of the standard Web Crypto API.
 *
 * ---- Setup (Cloudflare dashboard) ----
 * 1. Create a KV namespace (e.g. "AFTERGLOW_SUBS") and bind it to this
 *    Worker under the variable name SUBSCRIPTIONS.
 * 2. Add these environment variables:
 *      VAPID_PUBLIC_KEY   (plaintext var is fine — it's not secret)
 *      VAPID_PRIVATE_KEY  (add as a "Secret", not a plaintext var)
 *      VAPID_SUBJECT       e.g. "mailto:you@example.com" (required by spec)
 * 3. Add a Cron Trigger set to run every 5 minutes (see cron syntax below).
 * 4. Deploy, then note the Worker's URL — that's what index.html calls.
 */
// Cron Trigger expression to enter in the dashboard: every 5 minutes

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ---------- base64url helpers ----------

function base64UrlToUint8Array(base64url) {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const raw = atob(padded + pad);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function uint8ArrayToBase64Url(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatUint8Arrays(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// ---------- VAPID JWT (RFC 8292) ----------

async function importVapidPrivateKey(publicKeyRaw, privateKeyB64Url) {
  // Reconstruct the JWK from the raw uncompressed public point (0x04||X||Y)
  // plus the private scalar 'd', since Web Crypto needs x/y/d together to
  // import an EC private key usable for signing.
  const x = publicKeyRaw.slice(1, 33);
  const y = publicKeyRaw.slice(33, 65);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: uint8ArrayToBase64Url(x),
    y: uint8ArrayToBase64Url(y),
    d: privateKeyB64Url,
    ext: true,
  };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

async function buildVapidHeader(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const publicKeyRaw = base64UrlToUint8Array(env.VAPID_PUBLIC_KEY);
  const privateKey = await importVapidPrivateKey(publicKeyRaw, env.VAPID_PRIVATE_KEY);

  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12h, spec max is ~24h
    sub: env.VAPID_SUBJECT,
  };

  const encoder = new TextEncoder();
  const headerB64 = uint8ArrayToBase64Url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = uint8ArrayToBase64Url(encoder.encode(JSON.stringify(payload)));
  const unsigned = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(unsigned)
  );

  // Web Crypto returns an ECDSA signature as raw (r||s), which is exactly
  // what JWS ES256 expects — no DER conversion needed here.
  const jwt = `${unsigned}.${uint8ArrayToBase64Url(new Uint8Array(signature))}`;

  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ---------- Payload encryption (RFC 8291 aes128gcm) ----------

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

async function encryptPayload(subscription, plaintextObj) {
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(JSON.stringify(plaintextObj));

  const uaPublicRaw = base64UrlToUint8Array(subscription.keys.p256dh); // 65 bytes
  const authSecret = base64UrlToUint8Array(subscription.keys.auth); // 16 bytes

  // Ephemeral application-server ECDH key pair for this one message.
  const asKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const asPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", asKeyPair.publicKey)
  );

  // Import the subscriber's p256dh as a public key we can derive against.
  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const ecdhSecretBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublicKey },
    asKeyPair.privateKey,
    256
  );
  const ecdhSecret = new Uint8Array(ecdhSecretBits);

  // --- HKDF #1: combine ECDH secret with the subscriber's auth secret ---
  const prkKey = await hmacSha256(authSecret, ecdhSecret);

  const keyInfo = concatUint8Arrays(
    encoder.encode("WebPush: info\0"),
    uaPublicRaw,
    asPublicRaw
  );
  const ikm = (await hmacSha256(prkKey, concatUint8Arrays(keyInfo, new Uint8Array([1])))).slice(0, 32);

  // --- HKDF #2: derive the content-encryption key and nonce (RFC 8188) ---
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);

  const cekInfo = encoder.encode("Content-Encoding: aes128gcm\0");
  const cek = (await hmacSha256(prk, concatUint8Arrays(cekInfo, new Uint8Array([1])))).slice(0, 16);

  const nonceInfo = encoder.encode("Content-Encoding: nonce\0");
  const nonce = (await hmacSha256(prk, concatUint8Arrays(nonceInfo, new Uint8Array([1])))).slice(0, 12);

  // Single-record message: append the 0x02 "last record" delimiter, no padding.
  const paddedPlaintext = concatUint8Arrays(plaintext, new Uint8Array([2]));

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, paddedPlaintext)
  );

  // aes128gcm header: salt(16) || record size(4, uint32BE) || keyid len(1) || keyid
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const keyIdLen = new Uint8Array([asPublicRaw.length]);

  const body = concatUint8Arrays(salt, recordSize, keyIdLen, asPublicRaw, ciphertext);

  return body;
}

// ---------- Sending a push ----------

async function sendPush(subscription, payloadObj, env) {
  const body = await encryptPayload(subscription, payloadObj);
  const authHeader = await buildVapidHeader(subscription.endpoint, env);

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "3600",
      "Authorization": authHeader,
    },
    body,
  });

  return res;
}

// ---------- HTTP handlers ----------

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleSubscribe(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { subscription, lat, lon, notify, minutesBefore } = data;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return jsonResponse({ error: "Missing subscription details" }, 400);
  }
  if (typeof lat !== "number" || typeof lon !== "number") {
    return jsonResponse({ error: "Missing lat/lon" }, 400);
  }

  const record = {
    subscription,
    lat,
    lon,
    notify: {
      sunrise: !!(notify && notify.sunrise),
      sunset: !!(notify && notify.sunset),
      goldenMorning: !!(notify && notify.goldenMorning),
      goldenEvening: !!(notify && notify.goldenEvening),
    },
    minutesBefore: Number.isFinite(minutesBefore) ? minutesBefore : 60,
    lastSent: {}, // e.g. { "2026-09-21-sunset": true }
  };

  const key = "sub:" + (await sha256Hex(subscription.endpoint));
  await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));

  return jsonResponse({ ok: true });
}

async function handleUnsubscribe(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!data.endpoint) return jsonResponse({ error: "Missing endpoint" }, 400);

  const key = "sub:" + (await sha256Hex(data.endpoint));
  await env.SUBSCRIPTIONS.delete(key);
  return jsonResponse({ ok: true });
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Solar math (ported from index.html, kept in sync) ----------
// Same low-precision NOAA/Meeus approach the app's client-side code uses for
// "Golden hour" on the Today tab — this keeps the alert timing consistent
// with what the app shows, since Open-Meteo only gives us sunrise/sunset,
// not arbitrary sun-angle crossings.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const dsin = (d) => Math.sin(d * D2R);
const dcos = (d) => Math.cos(d * D2R);
const dtan = (d) => Math.tan(d * D2R);
const dacosc = (x) => Math.acos(Math.max(-1, Math.min(1, x))) * R2D;
const dasinc = (x) => Math.asin(Math.max(-1, Math.min(1, x))) * R2D;

function solarPosition(date) {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;

  let L0 = 280.46646 + T * (36000.76983 + T * 0.0003032);
  L0 = ((L0 % 360) + 360) % 360;

  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  const C = dsin(M) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + dsin(2 * M) * (0.019993 - 0.000101 * T)
          + dsin(3 * M) * 0.000289;

  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * dsin(omega);

  const seconds = 21.448 - T * (46.8150 + T * (0.00059 - T * 0.001813));
  const e0 = 23 + (26 + seconds / 60) / 60;
  const obliqCorr = e0 + 0.00256 * dcos(omega);

  const decl = dasinc(dsin(obliqCorr) * dsin(lambda));

  const y = dtan(obliqCorr / 2) * dtan(obliqCorr / 2);
  const eqTime = 4 * R2D * (
      y * dsin(2 * L0)
      - 2 * e * dsin(M)
      + 4 * e * y * dsin(M) * dcos(2 * L0)
      - 0.5 * y * y * dsin(4 * L0)
      - 1.25 * e * e * dsin(2 * M)
  );

  return { decl, eqTime };
}

// Returns the Date the sun crosses the given zenith angle (90 = horizon,
// <90 = above horizon, >90 = below horizon) on the way up ("dawn") or down
// ("dusk") relative to eventDate. Mirrors the app's civilTwilight() exactly,
// so "6° above horizon" (zenith 84) and "4° below horizon" (zenith 94) match
// what's shown as Golden Hour on the Today tab. Returns null if the sun
// never reaches that angle that day (deep polar latitudes).
function sunCrossing(eventDate, lat, lon, which, zenith) {
  const { decl, eqTime } = solarPosition(eventDate);
  const cosHA = (dcos(zenith) - dsin(lat) * dsin(decl)) / (dcos(lat) * dcos(decl));
  if (cosHA > 1 || cosHA < -1) return null;
  const ha = dacosc(cosHA);

  const trueSolarTime = which === "dawn" ? (720 - ha * 4) : (720 + ha * 4);
  let utcMinutes = trueSolarTime - eqTime - 4 * lon;
  utcMinutes = ((utcMinutes % 1440) + 1440) % 1440;

  const dayStartUTC = Date.UTC(eventDate.getUTCFullYear(), eventDate.getUTCMonth(), eventDate.getUTCDate());
  return new Date(dayStartUTC + utcMinutes * 60000);
}

// ---------- Cron: check every subscription against sun events ----------

async function fetchSunTimes(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Open-Meteo request failed: " + res.status);
  const data = await res.json();

  // Open-Meteo returns times like "2026-09-23T19:09" with NO timezone marker
  // — those digits are the location's local wall-clock time, not UTC. This
  // Worker always runs in UTC, so naively doing `new Date(thatString)` reads
  // the digits as if they were already UTC, silently shifting every event by
  // the location's UTC offset (4-5 hours for US timezones). Correct for it
  // using the utc_offset_seconds the API also returns.
  const offsetSec = data.utc_offset_seconds || 0;
  function toRealUTC(localStr) {
    const asIfUTC = new Date(localStr + "Z");
    return new Date(asIfUTC.getTime() - offsetSec * 1000);
  }

  const sunrise = toRealUTC(data.daily.sunrise[0]);
  const sunset = toRealUTC(data.daily.sunset[0]);

  // Golden hour start: 6° above horizon before sunset (evening), 4° below
  // horizon before sunrise (morning) — same definition as the app's Today
  // tab, so "golden hour" means the same thing everywhere in Afterglow.
  const goldenEveningStart = sunCrossing(sunset, lat, lon, "dusk", 84) || new Date(sunset.getTime() - 60 * 60000);
  const goldenMorningStart = sunCrossing(sunrise, lat, lon, "dawn", 94) || new Date(sunrise.getTime() - 20 * 60000);

  return { sunrise, sunset, goldenEveningStart, goldenMorningStart };
}

async function runScheduledCheck(env) {
  const now = new Date();
  const list = await env.SUBSCRIPTIONS.list({ prefix: "sub:" });

  for (const { name: key } of list.keys) {
    let record;
    try {
      record = JSON.parse(await env.SUBSCRIPTIONS.get(key));
    } catch {
      continue;
    }
    if (!record) continue;

    try {
      const { sunrise, sunset, goldenEveningStart, goldenMorningStart } = await fetchSunTimes(record.lat, record.lon);
      const dateStr = now.toISOString().slice(0, 10);

      const events = [];
      if (record.notify.sunrise) events.push({ name: "sunrise", time: sunrise, label: "Sunrise" });
      if (record.notify.sunset) events.push({ name: "sunset", time: sunset, label: "Sunset" });
      if (record.notify.goldenMorning) events.push({ name: "goldenMorning", time: goldenMorningStart, label: "Morning golden hour" });
      if (record.notify.goldenEvening) events.push({ name: "goldenEvening", time: goldenEveningStart, label: "Evening golden hour" });

      let changed = false;

      for (const ev of events) {
        const triggerTime = new Date(ev.time.getTime() - record.minutesBefore * 60 * 1000);
        const diffMinutes = (now.getTime() - triggerTime.getTime()) / 60000;
        const sentKey = `${dateStr}-${ev.name}`;

        // Fire once the trigger time has passed, within a window matching
        // the cron interval, and only once per day per event.
        if (diffMinutes >= 0 && diffMinutes < 5 && !record.lastSent[sentKey]) {
          const res = await sendPush(record.subscription, {
            title: `Afterglow`,
            body: `${ev.label} in ${record.minutesBefore} minutes`,
            tag: sentKey,
          }, env);

          if (res.status === 404 || res.status === 410) {
            // Subscription is gone (user uninstalled, permission revoked, etc.)
            console.log(`Afterglow cron: subscription ${key} gone (${res.status}), removing`);
            await env.SUBSCRIPTIONS.delete(key);
            changed = false;
            break;
          }

          if (res.ok) {
            console.log(`Afterglow cron: sent ${sentKey} to ${key} — status ${res.status}`);
            record.lastSent[sentKey] = true;
            changed = true;
          } else {
            // Don't mark as sent on failure — a bad response (bad VAPID,
            // malformed payload, etc.) would otherwise be silently swallowed
            // and never retried. Leaving lastSent unset lets the next cron
            // tick (within the same 5-minute window) try again.
            const bodyText = await res.text().catch(() => "(no body)");
            console.error(`Afterglow cron: push FAILED for ${sentKey} on ${key} — status ${res.status}: ${bodyText}`);
          }
        }
      }

      // Trim lastSent entries older than 2 days so the record doesn't grow forever.
      for (const k of Object.keys(record.lastSent)) {
        const d = k.slice(0, 10);
        if (d < new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10)) {
          delete record.lastSent[k];
          changed = true;
        }
      }

      if (changed) {
        await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
      }
    } catch (err) {
      console.error("Afterglow cron: error processing", key, err);
      // Keep going — one bad subscription/location shouldn't stop the rest.
    }
  }
}

// ---------- Entry points ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
    }
    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      return handleUnsubscribe(request, env);
    }
    if (url.pathname === "/vapid-public-key" && request.method === "GET") {
      return jsonResponse({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    return new Response("Afterglow push worker is running.", { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};
