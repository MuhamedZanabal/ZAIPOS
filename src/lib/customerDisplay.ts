/**
 * Customer-facing display feed. The register publishes the current ticket to
 * localStorage (+ BroadcastChannel when available); the display window, which
 * has no preload bridge and no IPC, only reads it. Nothing here is secret: it
 * is what the customer sees on the counter screen anyway.
 */
export const CUSTOMER_DISPLAY_KEY = "zaipos.customerDisplay.v1";
const CHANNEL = "zaipos-customer-display";

export interface CustomerDisplayLine { name: string; quantity: number; totalFils: number }
export interface CustomerDisplayState {
  status: "idle" | "active" | "paid";
  businessName?: string;
  lines: CustomerDisplayLine[];
  discountFils: number;
  vatFils: number;
  totalFils: number;
  paidFils?: number;
  changeFils?: number;
  updatedAt: number;
}

export const IDLE_STATE: CustomerDisplayState = { status: "idle", lines: [], discountFils: 0, vatFils: 0, totalFils: 0, updatedAt: 0 };

function channel(): BroadcastChannel | null {
  try { return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL); } catch { return null; }
}

export function publishCustomerDisplay(state: Omit<CustomerDisplayState, "updatedAt">): void {
  const full: CustomerDisplayState = { ...state, lines: state.lines.slice(-50), updatedAt: Date.now() };
  try { localStorage.setItem(CUSTOMER_DISPLAY_KEY, JSON.stringify(full)); } catch { /* storage full or disabled */ }
  const ch = channel();
  if (ch) { ch.postMessage(full); ch.close(); }
}

const isFils = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n);

/** Validates whatever is in storage; a malformed value shows the idle screen. */
export function parseCustomerDisplay(raw: unknown): CustomerDisplayState {
  const value = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!value || typeof value !== "object") return IDLE_STATE;
  const v = value as Partial<CustomerDisplayState>;
  if (!["idle", "active", "paid"].includes(String(v.status)) || !Array.isArray(v.lines)) return IDLE_STATE;
  if (![v.discountFils, v.vatFils, v.totalFils].every(isFils)) return IDLE_STATE;
  const lines = v.lines
    .filter((l): l is CustomerDisplayLine => !!l && typeof l.name === "string" && typeof l.quantity === "number" && isFils(l.totalFils))
    .map((l) => ({ name: l.name.slice(0, 80), quantity: l.quantity, totalFils: l.totalFils }));
  return {
    status: v.status as CustomerDisplayState["status"],
    businessName: typeof v.businessName === "string" ? v.businessName.slice(0, 80) : undefined,
    lines, discountFils: v.discountFils!, vatFils: v.vatFils!, totalFils: v.totalFils!,
    paidFils: isFils(v.paidFils) ? v.paidFils : undefined,
    changeFils: isFils(v.changeFils) ? v.changeFils : undefined,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
  };
}

export function subscribeCustomerDisplay(onChange: (state: CustomerDisplayState) => void): () => void {
  const read = () => onChange(parseCustomerDisplay(localStorage.getItem(CUSTOMER_DISPLAY_KEY)));
  const onStorage = (e: StorageEvent) => { if (e.key === CUSTOMER_DISPLAY_KEY) read(); };
  window.addEventListener("storage", onStorage);
  const ch = channel();
  if (ch) ch.onmessage = (e) => onChange(parseCustomerDisplay(e.data));
  // Fallback poll: file:// windows do not always share storage events.
  const timer = window.setInterval(read, 1000);
  read();
  return () => { window.removeEventListener("storage", onStorage); ch?.close(); window.clearInterval(timer); };
}

/** BHD with three decimals, Western digits on both languages (as on NBR receipts). */
export function bhd(fils: number): string {
  const sign = fils < 0 ? "-" : "";
  const abs = Math.abs(fils);
  return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
}
