// Runs the Worker's 5-minute check against a pretend KV store, Open-Meteo and push service.
// Run: node cron-test.mjs   (from the folder holding worker.js)
import fs from "fs"; import { webcrypto } from "crypto";
let src = fs.readFileSync("worker.js", "utf8").replace("export default", "const __default =") + "\nexport { runScheduledCheck, handleSubscribe };\n";
fs.writeFileSync("/tmp/_worker_cron.mjs", src);
const W = await import("/tmp/_worker_cron.mjs");
const b64u = u => Buffer.from(u).toString("base64url");

// Real keys so the push encryption/signing code runs for real.
const vapid = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const vj = await webcrypto.subtle.exportKey("jwk", vapid.privateKey);
const vpub = new Uint8Array(await webcrypto.subtle.exportKey("raw", vapid.publicKey));
const ua = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPub = new Uint8Array(await webcrypto.subtle.exportKey("raw", ua.publicKey));
const env0 = { VAPID_PUBLIC_KEY: b64u(vpub), VAPID_PRIVATE_KEY: vj.d, VAPID_SUBJECT: "mailto:test@example.com" };

let fails = 0;
const expect = (name, ok, extra="") => { if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + name + (extra ? "  " + extra : "")); };

function makeKV(){ const m = new Map(); return { m,
  async list(){ return { keys: [...m.keys()].map(name => ({ name })) }; },
  async get(k){ return m.get(k) ?? null; }, async put(k,v){ m.set(k,v); }, async delete(k){ m.delete(k); } }; }

// Pretend Open-Meteo: sun times fixed relative to "now", clouds chosen by scenario.
function installFetch(sc){
  const log = { pushes: [], forecastCalls: 0 };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://push.example")) { log.pushes.push(init); return { ok: true, status: 201, text: async () => "" }; }
    const p = new URL(u).searchParams;
    if (p.get("daily")) { // sun times
      const iso = d => new Date(d).toISOString().slice(0, 16);
      return { ok: true, json: async () => ({ utc_offset_seconds: 0, daily: {
        sunrise: [iso(sc.sunrise)], sunset: [iso(sc.sunset)] } }) };
    }
    log.forecastCalls++;
    const sample = p.get("hourly") === "cloud_cover_low,cloud_cover_mid";
    if (sc.failForecast) return { ok: false, status: 500, json: async () => ({}) };
    const base = Math.floor(Date.now() / 3600000) * 3600000 - 12 * 3600000;
    const times = Array.from({ length: 48 }, (_, i) => new Date(base + i * 3600000).toISOString().slice(0, 16));
    const fill = v => times.map(() => v);
    if (sample) return { ok: true, json: async () => ({ utc_offset_seconds: 0, hourly: { time: times, cloud_cover_low: fill(sc.bl ?? 0), cloud_cover_mid: fill(sc.bm ?? 0) } }) };
    return { ok: true, json: async () => ({ utc_offset_seconds: 0, hourly: { time: times,
      cloud_cover_low: fill(sc.c[0]), cloud_cover_mid: fill(sc.c[1]), cloud_cover_high: fill(sc.c[2]),
      relative_humidity_2m: fill(55), precipitation_probability: fill(5), visibility: fill(24000) } }) };
  };
  return log;
}
const rec = (extra) => ({ subscription: { endpoint: "https://push.example/abc", keys: { p256dh: b64u(uaPub), auth: b64u(webcrypto.getRandomValues(new Uint8Array(16))) } },
  lat: 35.77, lon: -78.63, notify: { sunrise: false, sunset: true, goldenMorning: false, goldenEvening: false }, minutesBefore: 60, lastSent: {}, ...extra });
const soon = () => Date.now() + 59 * 60000;   // 59 minutes from now → inside the 60-minute alert window
const later = () => Date.now() + 10 * 3600000; // far away
const decode = init => init && init.body ? true : false;

async function run(name, record, sc, check){
  const kv = makeKV(); await kv.put("sub:x", JSON.stringify(record));
  const log = installFetch(sc);
  await W.runScheduledCheck({ ...env0, SUBSCRIPTIONS: kv });
  check(log, JSON.parse(kv.m.get("sub:x") || "null"));
}
const GOOD = [10, 25, 55];   // scores 55 (Good) with a clear beam
const key = () => `${new Date().toISOString().slice(0,10)}-sunset`;

await run("any sky sends, no forecast fetched", rec({}), { sunset: soon(), sunrise: later(), c: GOOD }, (log, r) => {
  expect("old-style record (no minScore) still sends", log.pushes.length === 1);
  expect("and fetches no forecast", log.forecastCalls === 0);
});
await run("sky below minimum stays quiet", rec({ minScore: { sunrise: 0, sunset: 70 } }), { sunset: soon(), sunrise: later(), c: GOOD }, (log, r) => {
  expect("Good (55) with Great needed: nothing sent", log.pushes.length === 0);
  expect("marked so it isn't re-checked this window", r.lastSent[key()] === "skipped");
});
await run("sky meets minimum sends", rec({ minScore: { sunrise: 0, sunset: 44 } }), { sunset: soon(), sunrise: later(), c: GOOD }, (log, r) => {
  expect("Good (55) with Good needed: sent", log.pushes.length === 1);
  expect("marked sent", r.lastSent[key()] === true);
});
await run("flat sky vs Epic", rec({ minScore: { sunrise: 0, sunset: 85 } }), { sunset: soon(), sunrise: later(), c: [2, 0, 3] }, (log) => {
  expect("clear sky with Epic needed: nothing sent", log.pushes.length === 0);
});
await run("sunrise and sunset have separate minimums",
  rec({ notify: { sunrise: true, sunset: true, goldenMorning: false, goldenEvening: false }, minScore: { sunrise: 85, sunset: 44 } }),
  { sunset: soon(), sunrise: soon(), c: GOOD }, (log, r) => {
  expect("sunset (needs Good) sends, sunrise (needs Epic) does not", log.pushes.length === 1 && r.lastSent[key()] === true && r.lastSent[key().replace("sunset", "sunrise")] === "skipped");
});
await run("forecast unavailable: send nothing, retry later", rec({ minScore: { sunrise: 0, sunset: 44 } }), { sunset: soon(), sunrise: later(), c: GOOD, failForecast: true }, (log, r) => {
  expect("nothing sent", log.pushes.length === 0);
  expect("not marked, so the next tick can retry", !r.lastSent[key()]);
});
await run("golden hour ignores the sky minimum", rec({ notify: { sunrise: false, sunset: false, goldenMorning: false, goldenEvening: true }, minScore: { sunrise: 85, sunset: 85 } }), { sunset: Date.now() + 3600000 + 40 * 60000 + 59*60000, sunrise: later(), c: [2,0,3] }, (log) => {
  expect("no crash, no forecast fetched", log.forecastCalls === 0);
});

// Subscribe handler stores only the offered levels.
const kv2 = makeKV();
const mkReq = body => ({ json: async () => body });
await W.handleSubscribe(mkReq({ subscription: rec({}).subscription, lat: 1, lon: 2, notify: { sunset: true }, minutesBefore: 30, minScore: { sunrise: 70, sunset: 12345 } }), { SUBSCRIPTIONS: kv2 });
const stored = JSON.parse([...kv2.m.values()][0]);
expect("subscribe keeps an offered level", stored.minScore.sunrise === 70);
expect("subscribe turns an unknown value into Any", stored.minScore.sunset === 0);
await W.handleSubscribe(mkReq({ subscription: rec({}).subscription, lat: 1, lon: 2, notify: { sunset: true } }), { SUBSCRIPTIONS: kv2 });
const stored2 = JSON.parse([...kv2.m.values()][0]);
expect("subscribe without minScore means Any", stored2.minScore.sunrise === 0 && stored2.minScore.sunset === 0);
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
