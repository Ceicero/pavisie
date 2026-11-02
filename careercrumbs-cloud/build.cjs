// Builds site/, the standalone website: full document, manifest, offline cache, icons, privacy page.
// The Android app (android/build.sh) packages the same build.
// Optional env: SITE_URL (https://… with trailing slash) adds canonical, og:url and absolute og:image;
// CONTACT_EMAIL fills in the privacy page contact.
// SUPABASE_URL and SUPABASE_ANON_KEY turn on optional accounts (see supabase/README.md). The anon key is
// public by design; row-level security in the database keeps each account's data to itself.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const here = (...p) => path.join(__dirname, ...p);
const src = (f) => fs.readFileSync(here("src", f), "utf8");
const site = (f) => fs.readFileSync(here("site-src", f), "utf8");

const styles = src("styles.css");
const logic = src("logic.js");
const app = src("app.js");
const supaUrl = process.env.SUPABASE_URL || "";
const supaKey = process.env.SUPABASE_ANON_KEY || "";
if (supaUrl && !/^https:\/\/[\w.-]+(:\d+)?\/?$/.test(supaUrl)) throw new Error("SUPABASE_URL must be an https URL like https://abc.supabase.co");
const config = "window.CC_CONFIG = " + JSON.stringify(supaUrl && supaKey ? { url: supaUrl, anonKey: supaKey } : null).replace(/</g, "\\u003c") + ";";

const out = here("site");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "fonts"), { recursive: true });
fs.mkdirSync(path.join(out, "icons"), { recursive: true });

const siteUrl = (process.env.SITE_URL || "").replace(/\/?$/, process.env.SITE_URL ? "/" : "");
const urlMeta = siteUrl
  ? ['<link rel="canonical" href="' + siteUrl + '">', '<meta property="og:url" content="' + siteUrl + '">', '<meta property="og:image" content="' + siteUrl + 'icons/og-image.png">'].join("\n")
  : '<meta property="og:image" content="icons/og-image.png">';
const index = site("shell.html")
  .replace("<!--SITE_URL_META-->", () => urlMeta)
  .replace("/*FONTS*/", () => site("fonts/fonts.css"))
  .replace("/*STYLES*/", () => styles)
  .replace("/*CONFIG*/", () => config)
  .replace("/*LOGIC*/", () => logic)
  .replace("/*VAULT*/", () => src("vault.js"))
  .replace("/*SYNC*/", () => src("sync.js"))
  .replace("/*APP*/", () => app);
fs.writeFileSync(path.join(out, "index.html"), index);

const contact = process.env.CONTACT_EMAIL || "[add a contact email before launch]";
fs.writeFileSync(path.join(out, "privacy.html"), site("privacy.html").replace("<!--CONTACT_EMAIL-->", contact));
for (const f of ["manifest.webmanifest", "robots.txt"]) fs.copyFileSync(here("site-src", f), path.join(out, f));
for (const f of fs.readdirSync(here("site-src", "fonts"))) if (/\.(woff2|md)$/.test(f)) fs.copyFileSync(here("site-src", "fonts", f), path.join(out, "fonts", f));
for (const f of fs.readdirSync(here("site-src", "icons"))) fs.copyFileSync(here("site-src", "icons", f), path.join(out, "icons", f));

// Offline cache: every file in the build, versioned by content so each build updates cleanly.
const files = [];
const walk = (dir, rel) => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, rel + f + "/");
    else if (!/\.md$|og-image/.test(f)) files.push(rel + f);
  }
};
walk(out, "");
const hash = crypto.createHash("sha256");
for (const f of files.sort()) hash.update(f).update(fs.readFileSync(path.join(out, f)));
const version = hash.digest("hex").slice(0, 10);
fs.writeFileSync(path.join(out, "sw.js"), site("sw.js").replace("/*VERSION*/", version).replace("/*FILES*/", JSON.stringify(["./"].concat(files))));
console.log("site/", files.length + 1, "files, version", version, "· index.html", (index.length / 1024).toFixed(1) + " KB · accounts " + (supaUrl && supaKey ? "on" : "off"));
