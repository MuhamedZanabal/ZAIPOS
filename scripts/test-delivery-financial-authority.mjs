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

// Client-side integer-fils arithmetic is permitted for a non-authoritative display estimate.
// What must never happen is sending a client-computed persisted order total to the server.
// register_delivery_order_v2 receives item identity/quantity plus exact input fils and must
// independently resolve authoritative product price, tax and final total at commit time.
assertNoMatch(
  "delivery does not submit a client-authoritative persisted total",
  delivery,
  /_(?:total|subtotal|tax)_fils\s*:/,
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
