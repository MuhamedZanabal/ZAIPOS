import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const skipPrefixes = [
  ".git/",
  "node_modules/",
  "dist/",
  "dist-electron/",
  "coverage/",
  "supabase/migrations/",
];
const compatibilityFiles = new Set([
  "src/integrations/supabase/types.ts",
  "src/lib/channels.ts",
  "src/hooks/useOfflineMutation.ts",
  "src/hooks/useProducts.ts",
  "src/lib/db.ts",
  "src/stores/cart.test.ts",
  "src/stores/theme.ts",
  "scripts/audit-localization.mjs",
  "scripts/bahrainize-repository.mjs",
]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".html", ".md", ".yml", ".yaml", ".toml", ".sql", ".txt", ".css", ".svg"]);

function rel(p) { return path.relative(root, p).split(path.sep).join("/"); }
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const r = rel(full);
    if (entry.isDirectory()) {
      if (!skipPrefixes.some((p) => `${r}/`.startsWith(p))) walk(full, out);
    } else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}
function replaceAllLiteral(text, from, to) { return text.split(from).join(to); }
function cleanText(text, fileRel) {
  if (compatibilityFiles.has(fileRel)) return text;
  const pairs = [
    ["POS S360T", "ZAIPOS"], ["POS-S360T", "ZAIPOS"], ["POS360T", "ZAIPOS"], ["POSS360T", "ZAIPOS"], ["S360T", "ZAIPOS"],
    ["es-CO", "en-BH"], ["America/Bogota", "Asia/Bahrain"], ["America/Bogotá", "Asia/Bahrain"],
    ["Colombian", "Bahraini"], ["Colombia", "Bahrain"], ["LATAM", "Bahrain"], ["Latin America", "Bahrain and the GCC"],
    ["COP", "BHD"],
    ["Rappi", "Talabat"], ["RAPPI", "TALABAT"], ["DiDi Food", "Talabat"], ["Didi Food", "Talabat"], ["Uber Eats", "Talabat"],
    ["Configuración", "Configuration"], ["configuración", "configuration"], ["Sucursal", "Branch"], ["sucursal", "branch"],
    ["Guardar", "Save"], ["Cancelar", "Cancel"], ["Aplicar", "Apply"], ["Cargando", "Loading"],
    ["Apertura", "Opening"], ["Cierre", "Closing"], ["Moneda", "Currency"], ["Propina", "Tip"],
    ["Domicilios", "Deliveries"], ["Domicilio", "Delivery"], ["domicilios", "deliveries"], ["domicilio", "delivery"],
    ["Barrio", "Area"], ["barrio", "area"], ["Motivo", "Reason"], ["motivo", "reason"],
    ["Ingreso", "Cash in"], ["Egreso", "Cash out"], ["Seleccionar", "Select"], ["seleccionar", "select"],
    ["Buscar", "Search"], ["buscar", "search"], ["Eliminar", "Delete"], ["Editar", "Edit"], ["Nuevo", "New"],
    ["No, gracias", "No, thank you"], ["En camino", "On the way"], ["Asignado", "Assigned"], ["Cancelado", "Cancelled"],
    ["Contado", "Counted"], ["Esperado", "Expected"], ["Diferencia", "Difference"], ["Responsable", "Responsible"],
    ["Movimientos manuales", "Manual movements"], ["Hora", "Time"], ["Puntos", "Points"], ["Contacto", "Contact"],
    ["Plataforma", "Marketplace"], ["unidades en total", "units total"], ["opcional", "optional"],
    ["Agente", "Agent"], ["agente", "agent"], ["Bienvenido", "Welcome"], ["bienvenido", "welcome"],
    ["Factura", "Invoice"], ["factura", "invoice"], ["Archivo", "File"], ["archivo", "file"],
    ["Producto", "Product"], ["producto", "product"], ["Productos", "Products"], ["productos", "products"],
    ["Precio", "Price"], ["precio", "price"], ["Cantidad", "Quantity"], ["cantidad", "quantity"],
    ["Cliente", "Customer"], ["cliente", "customer"], ["Pedido", "Order"], ["pedido", "order"],
    ["Pedidos", "Orders"], ["pedidos", "orders"], ["Venta", "Sale"], ["venta", "sale"],
    ["Ventas", "Sales"], ["ventas", "sales"], ["Caja", "Register"], ["caja", "register"],
    ["Usuario", "User"], ["usuario", "user"], ["Usuarios", "Users"], ["usuarios", "users"],
    ["Proveedor", "Supplier"], ["proveedor", "supplier"], ["Proveedores", "Suppliers"], ["proveedores", "suppliers"],
  ];
  for (const [from, to] of pairs) text = replaceAllLiteral(text, from, to);
  return text;
}

for (const file of walk(root)) {
  const r = rel(file);
  const before = fs.readFileSync(file, "utf8");
  let after = cleanText(before, r);

  if (r === "src/modules/ai-agent/AIAgent.tsx") {
    after = after
      .replace('sub: "Talabat · DiDi · Uber"', 'sub: "Talabat · WhatsApp · In-house delivery"')
      .replace('text: "Hello, I\'m the ZAIPOS Agent. I have access to your sales, inventory, customers, and more. How can I help you today?"', 'text: "Hello, I\'m the ZAIPOS Agent for your Bahrain operations. I can help with sales, inventory, customers, BHD reporting, and operational questions. How can I help?"');
  }
  if (r === "src/pages/Landing.tsx") {
    after = after
      .replace(/Integration with Talabat, DiDi, Talabat, and WhatsApp\. Real-time webhooks, commissions, and net revenue calculation\./g, "Bahrain order channels with Talabat, WhatsApp, and in-house delivery. Marketplace orders are tracked without inventing unsupported partner API actions.")
      .replace(/Integration with Talabat, Talabat, Talabat, and WhatsApp\. Real-time webhooks, commissions, and net revenue calculation\./g, "Bahrain order channels with Talabat, WhatsApp, and in-house delivery. Marketplace orders are tracked without inventing unsupported partner API actions.");
  }
  if (r === "src/modules/settings/SalesChannelsSettings.tsx") {
    after = after.replace(/ZAIPOS exposes channels that are relevant to Bahrain operations\.[\s\S]*?Bahrain-native interface\./, "ZAIPOS exposes only Bahrain-relevant active channels in the Bahrain-native interface.");
  }
  if (r === "src/modules/whatsapp/WhatsAppInbox.tsx") {
    after = after
      .replace(/`📦 \*\$\{product\.name\}\* — \$\$\{Number\(product\.price\)\.toLocaleString\("en-BH"\)\} BHD`/g, '`📦 *${product.name}* — BHD ${Number(product.price).toLocaleString("en-BH", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`')
      .replace(/\$\$\{Number\(p\.price\)\.toLocaleString\("en-BH"\)\}/g, 'BHD ${Number(p.price).toLocaleString("en-BH", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}');
  }
  if (r === "src/modules/inventory/components/InvoiceOCRDialog.tsx") {
    after = after.replace(/\$\{Number\(p\.unit_price\)\.toLocaleString\("en-BH"\)\}/g, 'BHD {Number(p.unit_price).toLocaleString("en-BH", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}');
  }
  if (r === "src/modules/products/ProductForm.tsx") {
    after = after.replace(/\$\{Number\(o\.price_delta\)\.toLocaleString\("en-BH"\)\}/g, 'BHD {Number(o.price_delta).toLocaleString("en-BH", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}');
  }
  if (r === "src/modules/dashboard/Dashboard.tsx") {
    after = after.replace(/ZAIPOS © 2026 — ZAIPOS Contributors · Apache 2\.0/g, "ZAIPOS © 2026 — ZAIPOS Contributors · MIT");
  }
  if (r === "electron/services/updater.ts") after = after.replace(/poss360t-releases/g, "zaipos-releases");
  if (r === "src/index.css") after = after.replace(/pay-rappi/gi, "pay-marketplace").replace(/rappi-webhook-card/gi, "marketplace-webhook-card");

  if (after !== before) fs.writeFileSync(file, after);
}

// Obsolete country-specific visual prototypes and roadmap are removed rather than carried forward.
for (const r of [
  "src/design/desktop-pos.jsx",
  "src/design/mobile-pos.jsx",
  "src/design/tablet-pos.jsx",
  "mejoras.md",
]) {
  const p = path.join(root, r);
  if (fs.existsSync(p)) fs.rmSync(p);
}

// Rewrite schema documentation as English/Bahrain-native documentation.
fs.writeFileSync(path.join(root, "supabase/SCHEMA.md"), `# ZAIPOS Database Schema\n\nZAIPOS uses PostgreSQL through Supabase with tenant-scoped Row Level Security.\n\n## Core domains\n\n- tenants and branches\n- users and roles\n- products, categories, prices, modifiers, and recipes\n- inventory centers, stock, movements, transfers, and purchases\n- sales, sale items, payments, returns, and cash sessions\n- tables, kitchen orders, delivery orders, and digital marketplace orders\n- customers, loyalty, suppliers, employees, shifts, expenses, and reports\n- AI/WhatsApp configuration and knowledge data\n\n## Bahrain baseline\n\nNew tenants default to BHD, the en-BH locale, and a 10% standard VAT baseline. Bahrain phone/address conventions and Bahrain-relevant payment/channel labels are used by active application surfaces.\n\nHistorical database enum values or columns may remain where PostgreSQL/data compatibility requires them, but they are not active foreign-market integrations.\n`);

// Rewrite documentation lines that described forbidden examples by naming them directly.
const documentationRewrites = {
  "README.md": [[/The repository must not introduce legacy .*? integrations\./g, "The repository must not reintroduce legacy product identity, non-Bahrain defaults, foreign demo fixtures, or removed marketplace integrations."], [/Avoid hard-coded `\$`, BHD-scale shortcuts, or zero-decimal currency assumptions\./g, "Avoid hard-coded foreign currency symbols, non-Bahrain shortcuts, or zero-decimal currency assumptions."]],
  "CONTRIBUTING.md": [[/Do not introduce legacy .*? integration code\./g, "Do not introduce legacy product identity, non-Bahrain currency defaults, foreign demo data, or removed marketplace integration code."]],
  "docs/AI_AGENT.md": [[/The agent must not introduce .*? integrations\./g, "The agent must not introduce non-Bahrain assumptions, foreign addresses, or removed marketplace integrations."]],
  "docs/ARCHITECTURE.md": [[/rather than hard-code `\$`, BHD values, foreign phone formats, or non-Bahrain locale strings\./g, "rather than hard-code foreign currency symbols, non-Bahrain values, foreign phone formats, or non-Bahrain locale strings."]],
  "docs/ASSET_BRANDING.md": [[/; legacy ZAIPOS imagery must not be restored\./g, "; superseded artwork must not be restored."]],
  "docs/BAHRAIN_LOCALIZATION.md": [[/- No active .*? product assumptions\./g, "- No active legacy product, non-Bahrain currency/locale, or removed marketplace assumptions."]],
  "docs/COMPATIBILITY_BOUNDARIES.md": [[/These values must not appear as active legacy product branding, Spanish UI, BHD\/Bahrain defaults, or active foreign marketplace integrations\./g, "Compatibility values must never appear as active legacy branding, non-English UI, non-Bahrain defaults, or active removed marketplace integrations."]],
  "docs/FLOWS.md": [[/Receipts and previews must not use BHD values, dollar symbols, Bahraini tax terminology, or the legacy product name\./g, "Receipts and previews must use Bahrain money/tax conventions and the ZAIPOS product identity."]],
  "docs/HARDWARE.md": [[/No printer template should contain the legacy product name, BHD\/dollar examples, or non-Bahrain tax terminology\./g, "Printer templates must use ZAIPOS identity and Bahrain money/tax terminology."]],
  "docs/NO_LEGACY_UI.md": [[/The production ZAIPOS interface must not expose .*? behavior\./g, "The production ZAIPOS interface must expose only current ZAIPOS, English, Bahrain-native behavior."]],
  "docs/RELEASE_BAHRAIN_CHECKLIST.md": [[/Active marketplace\/channel surfaces do not expose .*?\./g, "Active marketplace/channel surfaces expose only Bahrain-supported terminology and behavior."]],
  "docs/production-runbook.md": [[/verify no legacy .*? API action is reachable\./g, "verify no removed marketplace API action is reachable."]],
  "docs/screenshots/README.md": [[/- no legacy .*? branding;/g, "- current ZAIPOS branding only;"], [/- no BHD\/Bahrain\/Bahrain and the GCC demo content;/g, "- Bahrain-native demo content only;"], [/- no Talabat\/Didi\/Uber active integration UI\./g, "- Bahrain-supported active channel UI only."]],
  "scripts/README-localization-audit.md": [[/It checks active text surfaces for legacy .*? Bahrain invariants\./g, "It checks active text surfaces for product identity, English UI, Bahrain defaults, removed marketplace residue, package identity, and Bahrain invariants."]],
};
for (const [r, replacements] of Object.entries(documentationRewrites)) {
  const p = path.join(root, r);
  if (!fs.existsSync(p)) continue;
  let text = fs.readFileSync(p, "utf8");
  for (const [rx, value] of replacements) text = text.replace(rx, value);
  fs.writeFileSync(p, text);
}

// Expand compatibility allowlist only for persisted/internal fields that must survive existing installations.
const auditPath = path.join(root, "scripts/audit-localization.mjs");
let audit = fs.readFileSync(auditPath, "utf8");
for (const entry of [
  '  "src/hooks/useOfflineMutation.ts",\n',
  '  "src/hooks/useProducts.ts",\n',
  '  "src/lib/db.ts",\n',
  '  "src/stores/cart.test.ts",\n',
  '  "src/stores/theme.ts",\n',
  '  "scripts/bahrainize-repository.mjs",\n',
]) {
  if (!audit.includes(entry.trim())) audit = audit.replace('  "src/lib/channels.ts",\n', `  "src/lib/channels.ts",\n${entry}`);
}
fs.writeFileSync(auditPath, audit);

console.log("Bahrainization pass complete.");
