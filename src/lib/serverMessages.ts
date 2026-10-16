/**
 * Older database functions raise Spanish messages. Until each function is
 * migrated, show users English text. Also strips Electron's IPC wrapper
 * ("Error invoking remote method 'x': Error: ...").
 */
const EXACT: Record<string, string> = {
  "Bootstrap cerrado: el primer negocio ya existe": "Setup is closed: the first business already exists",
  "Cantidad inválida": "Invalid quantity",
  "Centro de inventario inválido": "Invalid inventory center",
  "Conversación no encontrada": "Conversation not found",
  "Cupón inválido o vencido": "Invalid or expired coupon",
  "El centro de origen y destino deben ser diferentes": "Source and destination centers must be different",
  "El nombre del negocio es requerido": "Business name is required",
  "El pedido digital no tiene items": "The digital order has no items",
  "El pedido no tiene items vinculados al catálogo": "The order has no items linked to the catalog",
  "El pedido no tiene items": "The order has no items",
  "Item de venta inválido": "Invalid sale item",
  "La caja ya está cerrada": "The register is already closed",
  "La comanda no tiene items": "The order has no items",
  "La mesa no tiene items despachados para cobrar": "Nothing to charge yet: mark the items as served first",
  "La venta no tiene items": "The sale has no items",
  "Mesa con pedido pendiente de pago": "This table has an order waiting for payment",
  "Mesa no disponible": "Table not available",
  "Monto inválido": "Invalid amount",
  "No hay caja abierta en esta sucursal. Abre caja antes de vender.": "No register is open at this branch. Open the register before selling.",
  "No hay caja abierta en esta sucursal.": "No register is open at this branch.",
  "PIN de supervisor requerido o inválido": "Supervisor PIN required or invalid",
  "Pedido sin venta asociada": "Order has no linked sale",
  "Producto no disponible": "Product not available",
  "Ya existe una caja abierta para esta sucursal/caja": "A register is already open for this branch",
};

const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^Cantidad de devolución inválida para (.+)$/, (m) => `Invalid return quantity for ${m[1]}`],
  [/^Los pagos \((.+)\) no coinciden con el total \((.+)\)$/, (m) => `Payments (${m[1]}) do not match the total (${m[2]})`],
];

export function englishServerMessage(message: string): string {
  let text = (message ?? "").trim();
  const ipc = /^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/;
  text = text.replace(ipc, "").trim();
  if (EXACT[text]) return EXACT[text];
  for (const [pattern, render] of PATTERNS) {
    const match = text.match(pattern);
    if (match) return render(match);
  }
  return text;
}
