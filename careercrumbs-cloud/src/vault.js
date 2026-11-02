// CareerCrumbs PIN lock: AES-GCM encryption with a key derived from the PIN (PBKDF2, SHA-256).
// It keeps someone casually opening the app on a shared phone from reading your answers.
// A short PIN can't stop a determined attacker with the phone's storage, so the UI says so.
(function (root) {
  "use strict";
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ITER = 310000;
  const CHECK = "careercrumbs";
  const subtle = () => (root.crypto && root.crypto.subtle) || null;

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  const available = () => !!subtle() && typeof root.crypto.getRandomValues === "function";
  const validPin = (pin) => /^\d{4,8}$/.test(String(pin || ""));
  const isBox = (v) => !!v && v.ccEnc === 1 && typeof v.iv === "string" && typeof v.ct === "string";

  async function deriveKey(pin, saltB64, iter) {
    const base = await subtle().importKey("raw", enc.encode(String(pin)), "PBKDF2", false, ["deriveKey"]);
    return subtle().deriveKey({ name: "PBKDF2", salt: unb64(saltB64), iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encrypt(key, value) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
    return { ccEnc: 1, iv: b64(iv), ct: b64(ct) };
  }
  async function decrypt(key, box) {
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
    return JSON.parse(dec.decode(pt));
  }
  // New lock: random salt, plus an encrypted check value so a wrong PIN is detected without touching data.
  async function createLock(pin, iter) {
    const n = iter || ITER;
    const salt = b64(root.crypto.getRandomValues(new Uint8Array(16)));
    const key = await deriveKey(pin, salt, n);
    return { meta: { v: 1, salt, iter: n, check: await encrypt(key, CHECK) }, key };
  }
  // Returns the key for the right PIN, null for a wrong one.
  async function unlock(meta, pin) {
    if (!meta || !isBox(meta.check)) return null;
    const key = await deriveKey(pin, meta.salt, meta.iter || ITER);
    try {
      return (await decrypt(key, meta.check)) === CHECK ? key : null;
    } catch (e) {
      return null;
    }
  }
  // After repeated wrong PINs, wait 30 seconds, doubling each time up to 15 minutes.
  function lockoutMs(fails) {
    if (fails < 5) return 0;
    return Math.min(30000 * Math.pow(2, fails - 5), 15 * 60000);
  }

  const api = { available, validPin, isBox, createLock, unlock, encrypt, decrypt, lockoutMs, ITER };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CCVault = api;
})(typeof window !== "undefined" ? window : globalThis);
