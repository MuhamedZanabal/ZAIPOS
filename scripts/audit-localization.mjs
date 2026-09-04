import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const textExtensions = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".html",
  ".md", ".yml", ".yaml", ".toml", ".sql", ".txt", ".css", ".svg",
]);

const skippedDirectories = new Set([".git", "node_modules", "dist", "dist-electron", "coverage"]);
const compatibilityFiles = new Set([
  "src/integrations/supabase/types.ts",
  "src/lib/channels.ts",
  "scripts/bahrainize-repository.mjs",
  "src/stores/theme.ts",
  "src/stores/cart.test.ts",
  "src/lib/db.ts",
  "src/hooks/useProducts.ts",
  "src/hooks/useOfflineMutation.ts",
]);
const compatibilityPrefixes = [
  "supabase/migrations/",
];
const selfPath = "scripts/audit-localization.mjs";

const join = (...parts) => parts.join("");
const legacyBrand = join("POS", " S", "360T");
const legacyBrandCompact = join("POS", "360T");
const legacyBrandHyphen = join("POS-", "S360T");
const legacyPackage = join("poss", "360t");
const legacyToken = join("s", "360t");
const oldRepo = join("mateopiza/", "ai-point-of-sale");
const oldLocale = join("es", "-CO");
const oldCurrency = join("C", "OP");
const oldMarketplaces = [join("Rap", "pi"), join("Di", "di Food"), join("Uber", " Eats")];

const spanishUiTokens = [
  "Guardar", "Cancelar", "Aplicar", "Cargando", "Apertura", "Cierre", "Sucursal",
  "Configuración", "Moneda", "Propina", "Domicilio", "Barrio", "Motivo", "Ingreso",
  "Egreso", "Seleccionar", "Buscar", "Eliminar", "Editar", "Nuevo", "No, gracias",
  "En camino", "Asignado", "Cancelado", "Contado", "Esperado", "Diferencia",
  "Responsable", "Movimientos manuales", "Hora", "Puntos", "Contacto", "Plataforma",
];

const checks = [
  { name: "legacy product branding", test: (s) => [legacyBrand, legacyBrandCompact, legacyBrandHyphen, legacyPackage, legacyToken].some((v) => s.toLowerCase().includes(v.toLowerCase())) },
  { name: "legacy upstream repository", test: (s) => s.toLowerCase().includes(oldRepo.toLowerCase()) },
  { name: "non-Bahrain locale", test: (s) => s.includes(oldLocale) },
  { name: "non-Bahrain currency default", test: (s) => new RegExp(`\\b${oldCurrency}\\b`).test(s) },
  { name: "inactive foreign marketplace", test: (s) => oldMarketplaces.some((v) => s.toLowerCase().includes(v.toLowerCase())) },
  { name: "known Spanish UI residue", test: (s) => spanishUiTokens.some((v) => s.includes(v)) },
];

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isCompatibilityFile(file) {
  return compatibilityFiles.has(file) || compatibilityPrefixes.some((prefix) => file.startsWith(prefix));
}

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skippedDirectories.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const failures = [];
for (const file of collect(root)) {
  const fileRel = rel(file);
  if (fileRel === selfPath || isCompatibilityFile(fileRel)) continue;
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const check of checks) {
      if (check.test(lines[i])) failures.push(`${fileRel}:${i + 1}: ${check.name}: ${lines[i].trim()}`);
    }
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
if (packageJson.name !== "zaipos" || packageJson.productName !== "ZAIPOS") {
  failures.push("package.json: package identity must be zaipos / ZAIPOS");
}
if (packageLock.name !== "zaipos" || packageLock.packages?.[""]?.name !== "zaipos") {
  failures.push("package-lock.json: package identity must be zaipos at root and packages['']");
}

const bahrain = fs.readFileSync(path.join(root, "src/lib/bahrain.ts"), "utf8");
for (const required of ["BHD", "en-BH", "+973", "10"]) {
  if (!bahrain.includes(required)) failures.push(`src/lib/bahrain.ts: missing Bahrain invariant ${required}`);
}

if (failures.length) {
  console.error(`ZAIPOS localization audit failed with ${failures.length} finding(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PASS: active repository surfaces are ZAIPOS-branded, English-facing, and Bahrain-native.");
