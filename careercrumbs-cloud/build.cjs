// Builds two outputs from the same source:
//   careercrumbs.html — the claude.ai page (the artifact supplies the document head)
//   site/             — the standalone website: full document, manifest, offline cache, icons, privacy page
// Optional env: SITE_URL (https://… with trailing slash) adds canonical, og:url and absolute og:image;
// CONTACT_EMAIL fills in the privacy page contact.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const here = (...p) => path.join(__dirname, ...p);
const src = (f) => fs.readFileSync(here("src", f), "utf8");
const site = (f) => fs.readFileSync(here("site-src", f), "utf8");

const styles = src("styles.css");
const logic = src("logic.js");
const app = src("app.js");

// 1. claude.ai page
const artifact = src("shell.html").replace("/*STYLES*/", () => styles).replace("/*LOGIC*/", () => logic).replace("/*APP*/", () => app);
fs.writeFileSync(here("careercrumbs.html"), artifact);
console.log("careercrumbs.html", (artifact.length / 1024).toFixed(1) + " KB");

// 2. standalone site
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
  .replace("/*LOGIC*/", () => logic)
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
console.log("site/", files.length + 1, "files, version", version, "· index.html", (index.length / 1024).toFixed(1) + " KB");
