// Fails when a translated UI string has no Arabic entry, or a translation key is Spanish residue.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dictFiles = ["src/i18n/ar.ts", "src/i18n/ar.screens.ts"];
const keyPattern = /"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/g;
const ar = new Map();
const duplicates = [];
for (const file of dictFiles) {
  for (const m of fs.readFileSync(path.join(root, file), "utf8").matchAll(keyPattern)) { const k = JSON.parse(`"${m[1]}"`); if (ar.has(k)) duplicates.push(k); ar.set(JSON.parse(`"${m[1]}"`), JSON.parse(`"${m[2]}"`)); }
}
// Sample data, identifiers and protocol values intentionally stay as-is.
const untranslatable = /@|^\+973|^e\.g\. zaipos|^[A-Z_]+$|^[\d\s×#:·.,-]+$/;
const spanish = /[ñ¿¡]|\b(acceso|alerta|borrador|cargar|recibir|revertir|transferir|usar|ver|guardar|cancelar|eliminar|nuevo|mesa|cocina|cliente|proveedor|merma|miembros|observaciones|urgente|unidades|proyecciones|centros|margen|consistencia|complementarios)\b/i;
const callPattern = /\b(?:t|tx|translate)\(\s*("(?:[^"\\]|\\.)*")\s*[,)]/g;

const problems = duplicates.map((k) => `duplicate Arabic key "${k}"`);
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !full.includes(`${path.sep}i18n${path.sep}`)) {
      const text = fs.readFileSync(full, "utf8");
      if (!/from "@\/i18n"/.test(text)) continue;
      for (const m of text.matchAll(callPattern)) {
        const key = JSON.parse(m[1]);
        const rel = path.relative(root, full);
        if (spanish.test(key)) problems.push(`${rel}: Spanish UI text "${key}"`);
        else if (!untranslatable.test(key) && !ar.has(key)) problems.push(`${rel}: missing Arabic for "${key}"`);
      }
    }
  }
};
walk(path.join(root, "src"));
for (const [en, value] of ar) if (!/[\u0600-\u06FF]/.test(value)) problems.push(`Arabic entry for "${en}" contains no Arabic text`);

if (problems.length) {
  console.error(`FAIL: ${problems.length} Arabic localization problem(s):\n` + problems.join("\n"));
  process.exit(1);
}
console.log(`PASS: ${ar.size} Arabic strings; every translated UI string has an Arabic entry.`);
