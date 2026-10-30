// Inlines styles and scripts into one self-contained page: careercrumbs.html
const fs = require("fs");
const path = require("path");
const src = (f) => fs.readFileSync(path.join(__dirname, "src", f), "utf8");
const html = src("shell.html")
  .replace("/*STYLES*/", () => src("styles.css"))
  .replace("/*LOGIC*/", () => src("logic.js"))
  .replace("/*FEATURES*/", () => src("features.js"))
  .replace("/*APP*/", () => src("app.js"));
fs.writeFileSync(path.join(__dirname, "careercrumbs.html"), html);
console.log("careercrumbs.html", (html.length / 1024).toFixed(1) + " KB");
