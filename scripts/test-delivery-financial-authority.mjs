import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const delivery = readFileSync(`${root}/src/modules/delivery/Delivery.tsx`, "utf8");
const types = readFileSync(`${root}/src/integrations/supabase/types.ts`, "utf8");

function assertMatch(label, text, pattern) {
  if (!pattern.test(text)) throw new Error(`${label}: missing ${pattern}`);
}

function assertNoMatch(label, text, pattern) {
  if (pattern.test(text)) throw new Error(`${label}: forbidden ${pattern}`);
}

assertMatch("delivery UI uses the authoritative v2 command", delivery, /register_delivery_order_v2/);
assertNoMatch("legacy delivery command is retired from the client", delivery, /rpc\(["']register_delivery_order["']/);
assertMatch("delivery submits exact delivery-fee fils", delivery, /delivery_fee_fils/);
assertMatch("delivery submits exact item unit-price fils", delivery, /unit_price_fils/);
assertNoMatch(
  "delivery persisted total is not calculated with JS floating-point arithmetic",
  delivery,
  /line\.quantity\s*\*\s*line\.unit_price/,
);
assertNoMatch(
  "delivery price authority is not reconstructed through Number(product.price)",
  delivery,
  /Number\(product\.price\)/,
);

assertMatch("generated DB contract exposes exact delivery fee", types, /delivery_fee_fils:\s*number/);
assertMatch("generated DB contract exposes v2 delivery command", types, /register_delivery_order_v2:/);
assertMatch("v2 command accepts exact delivery-fee fils", types, /_delivery_fee_fils:\s*number/);

console.log("Delivery financial-authority static contract: PASS");
