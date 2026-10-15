// Bundles the frontend files into the Worker so ONE file (dist/worker.js)
// contains both the API and the website. Terraform uploads that file.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const appDir = join(root, "application");
const marker = "/*__ASSETS__*/ {}";

const assets = {};
for (const file of ["index.html", "style.css", "script.js"]) {
  assets[file] = readFileSync(join(appDir, file), "utf8");
}

const source = readFileSync(join(appDir, "worker.js"), "utf8");
if (!source.includes(marker)) {
  throw new Error(`Marker ${marker} not found in application/worker.js`);
}
// A replacer function is used so "$" characters in the assets are copied as-is.
const bundled = source.replace(marker, () => JSON.stringify(assets));

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "worker.js"), bundled);
console.log(`Built dist/worker.js (${(bundled.length / 1024).toFixed(1)} KB)`);
