// Checks that the Worker scores the sky exactly the way the app does.
// Run: node parity-test.mjs   (from the folder holding index.html and worker.js)
import fs from "fs"; import vm from "vm";
const html = fs.readFileSync("index.html", "utf8");
let wsrc = fs.readFileSync("worker.js", "utf8");
wsrc = wsrc.replace("export default", "const __default =") +
  "\nexport { scoreEvent, label, solarHorizontal, projectPoint, scoreSkyAt, beamFactor };\n";
fs.writeFileSync("/tmp/_worker_under_test.mjs", wsrc);

// Pull the app's functions out of index.html as text and run them in a sandbox.
function fn(name){
  const a = html.indexOf("function " + name + "(");
  let i = html.indexOf("{", a), d = 0;
  for (let j = i; j < html.length; j++){
    if (html[j] === "{") d++; else if (html[j] === "}" && --d === 0) return html.slice(a, j + 1);
  }
}
const names = ["solarPosition","solarHorizontal","projectPoint","beamFactor","scoreEvent","label","nearestHourIdx","sampleAt"];
const pre = `const D2R=Math.PI/180,R2D=180/Math.PI;const dsin=d=>Math.sin(d*D2R),dcos=d=>Math.cos(d*D2R),dtan=d=>Math.tan(d*D2R);
const dacosc=x=>Math.acos(Math.max(-1,Math.min(1,x)))*R2D,dasinc=x=>Math.asin(Math.max(-1,Math.min(1,x)))*R2D;const SUN_PATH_SAMPLE_KM=180;`;
const ctx = vm.createContext({ Math, Date });
vm.runInContext(pre + names.map(fn).join("\n"), ctx);
const app = n => ctx[n] ?? vm.runInContext(n, ctx);

const W = await import("/tmp/_worker_under_test.mjs");
let fails = 0, checks = 0;
const eq = (what, a, b) => { checks++; if (JSON.stringify(a) !== JSON.stringify(b)) { fails++; console.log("MISMATCH", what, a, b); } };

// 1) Same inputs, same outputs, for the pure functions.
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let n = 0; n < 4000; n++){
  const h = {
    time: ["2026-11-02T17:00"],
    cloud_cover_low: [rnd()*100 | 0], cloud_cover_mid: [rnd()*100 | 0], cloud_cover_high: [rnd()*100 | 0],
    relative_humidity_2m: [rnd()*100 | 0], precipitation_probability: [rnd()*100 | 0],
    visibility: [rnd() < .2 ? null : rnd()*60000],
  };
  const beam = rnd() < .25 ? null : { low: rnd()*100, mid: rnd()*100 };
  eq("scoreEvent", app("scoreEvent")(h, 0, beam), W.scoreEvent(h, 0, beam));
}
for (let s = 0; s <= 100; s++) eq("label " + s, app("label")(s), W.label(s));
for (let n = 0; n < 500; n++){
  const lat = rnd()*120 - 60, lon = rnd()*360 - 180, t = new Date(Date.UTC(2026, 10, 1) + rnd()*8.64e7*60);
  eq("azimuth", app("solarHorizontal")(t, lat, lon), W.solarHorizontal(t, lat, lon));
  const az = rnd()*360;
  eq("projectPoint", app("projectPoint")(lat, lon, az, 180), W.projectPoint(lat, lon, az, 180));
}

// 2) Whole pipeline: a pretend Open-Meteo, then the app's steps vs. scoreSkyAt.
const place = { lat: 35.77, lon: -78.63, off: -5 * 3600 }; // Raleigh, EST after Nov 1
const sunsetUtc = new Date(Date.UTC(2026, 10, 2, 22, 5));  // 5:05 pm local
const localIso = d => new Date(d.getTime() + place.off * 1000).toISOString().slice(0, 16);
const times = Array.from({ length: 48 }, (_, i) => localIso(new Date(Date.UTC(2026, 10, 2, 5, 0) + i * 3600000)));
const scenarios = [
  { name: "flat clear",  c: [2,0,3], vis: 30000, bl: 0,  bm: 0 },
  { name: "good canvas", c: [10,25,55], vis: 24000, bl: 5, bm: 20 },
  { name: "beam blocked", c: [10,25,55], vis: 24000, bl: 85, bm: 60 },
  { name: "overcast",    c: [80,90,95], vis: 6000, bl: 70, bm: 80 },
  { name: "no visibility", c: [5,30,45], vis: null, bl: 10, bm: 10 },
];
for (const sc of scenarios){
  const mk = (arr) => times.map(() => arr);
  const core = { utc_offset_seconds: place.off, hourly: { time: times,
    cloud_cover_low: times.map(()=>sc.c[0]), cloud_cover_mid: times.map(()=>sc.c[1]), cloud_cover_high: times.map(()=>sc.c[2]),
    relative_humidity_2m: times.map(()=>55), precipitation_probability: times.map(()=>5),
    visibility: sc.vis == null ? undefined : times.map(()=>sc.vis) } };
  const samp = { utc_offset_seconds: place.off, hourly: { time: times, cloud_cover_low: times.map(()=>sc.bl), cloud_cover_mid: times.map(()=>sc.bm) } };
  globalThis.fetch = async (url) => {
    const isSample = /hourly=cloud_cover_low%2Ccloud_cover_mid&/.test(String(url));
    return { ok: true, json: async () => isSample ? samp : core };
  };
  const got = await W.scoreSkyAt(place.lat, place.lon, sunsetUtc);
  const idx = app("nearestHourIdx")(times, localIso(sunsetUtc));
  const sample = { time: times, low: samp.hourly.cloud_cover_low, mid: samp.hourly.cloud_cover_mid };
  const want = app("scoreEvent")(core.hourly, idx, app("sampleAt")(sample, localIso(sunsetUtc)));
  eq("pipeline " + sc.name, got && got.score, want.score);
  eq("label " + sc.name, got && got.label, app("label")(want.score));
  console.log(`${sc.name.padEnd(14)} app ${want.score} ${app("label")(want.score)} | worker ${got.score} ${got.label}`);
}
console.log(`${checks} checks, ${fails} mismatches`);
process.exit(fails ? 1 : 0);
