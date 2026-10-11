/**
 * One place that decides which features each business type gets.
 * Sidebar, route guards, POS controls and the product form all read from here.
 * Server-side checks (RLS, triggers) stay authoritative; this only shapes the UI.
 */
export const BUSINESS_MODES = ["RESTAURANT", "CAFE", "SUPERMARKET", "RETAIL"] as const;
export type BusinessMode = (typeof BUSINESS_MODES)[number];

export type Capability =
  | "tables"            // dine-in table service (cafe: available, off until enabled)
  | "waiter"
  | "kds"
  | "recipes"
  | "modifiers"
  | "kitchen_station"   // per-product kitchen routing in the product form
  | "delivery_platforms" // Talabat / delivery / courier / digital orders
  | "barcode_first"     // scan field is the main POS input
  | "weighed_items"     // sold by kg, 3-decimal quantities
  | "suppliers"
  | "inventory";

const CAPABILITIES: Record<BusinessMode, ReadonlySet<Capability>> = {
  RESTAURANT: new Set<Capability>(["tables", "waiter", "kds", "recipes", "modifiers", "kitchen_station", "delivery_platforms", "suppliers", "inventory"]),
  CAFE: new Set<Capability>(["tables", "waiter", "kds", "recipes", "modifiers", "kitchen_station", "delivery_platforms", "suppliers", "inventory"]),
  SUPERMARKET: new Set<Capability>(["barcode_first", "weighed_items", "suppliers", "inventory"]),
  RETAIL: new Set<Capability>(["barcode_first", "weighed_items", "suppliers", "inventory"]),
};

export type BusinessModeInfo = {
  mode: BusinessMode;
  label: string;
  tagline: string;
  /** Tables are part of the capability set but start switched off. */
  tablesOffByDefault: boolean;
  staffRoles: Array<"cashier" | "waiter" | "kitchen" | "inventory" | "manager">;
};

export const BUSINESS_MODE_INFO: Record<BusinessMode, BusinessModeInfo> = {
  RESTAURANT: { mode: "RESTAURANT", label: "Restaurant", tagline: "Tables, waiters, kitchen screen, recipes and Talabat orders.", tablesOffByDefault: false, staffRoles: ["cashier", "waiter", "kitchen", "manager"] },
  CAFE: { mode: "CAFE", label: "Café", tagline: "Fast counter service, kitchen screen and delivery. Tables can be switched on later.", tablesOffByDefault: true, staffRoles: ["cashier", "waiter", "kitchen", "manager"] },
  SUPERMARKET: { mode: "SUPERMARKET", label: "Supermarket / grocery", tagline: "Barcode scanning, items sold by weight, suppliers and stock.", tablesOffByDefault: false, staffRoles: ["cashier", "inventory", "manager"] },
  RETAIL: { mode: "RETAIL", label: "Retail shop", tagline: "General shop: barcode scanning, stock and suppliers.", tablesOffByDefault: false, staffRoles: ["cashier", "inventory", "manager"] },
};

export function normalizeBusinessMode(value: unknown): BusinessMode {
  const upper = typeof value === "string" ? value.trim().toUpperCase() : "";
  return (BUSINESS_MODES as readonly string[]).includes(upper) ? (upper as BusinessMode) : "RETAIL";
}

export function hasCapability(mode: BusinessMode | string, capability: Capability): boolean {
  return CAPABILITIES[normalizeBusinessMode(mode)].has(capability);
}

export function capabilitiesFor(mode: BusinessMode | string): Capability[] {
  return [...CAPABILITIES[normalizeBusinessMode(mode)]];
}

/** Route prefixes that need a capability. Anything not listed is mode-neutral. */
export const ROUTE_CAPABILITIES: ReadonlyArray<{ prefix: string; capability: Capability }> = [
  { prefix: "/tables", capability: "tables" },
  { prefix: "/waiter", capability: "waiter" },
  { prefix: "/kds", capability: "kds" },
  { prefix: "/recipes", capability: "recipes" },
  { prefix: "/digital-orders", capability: "delivery_platforms" },
  { prefix: "/delivery", capability: "delivery_platforms" },
  { prefix: "/courier", capability: "delivery_platforms" },
  { prefix: "/suppliers", capability: "suppliers" },
  { prefix: "/inventory", capability: "inventory" },
];

export function capabilityForPath(pathname: string): Capability | undefined {
  return ROUTE_CAPABILITIES.find(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.capability;
}

export function canAccessPathInMode(mode: BusinessMode | string, pathname: string): boolean {
  const capability = capabilityForPath(pathname);
  return capability === undefined || hasCapability(mode, capability);
}

/** Business types where table service is allowed at all (mirrors the DB trigger). */
export function allowsTableService(mode: BusinessMode | string): boolean {
  return hasCapability(mode, "tables");
}

/** Sales channels that depend on a capability (others are always allowed). */
const CHANNEL_CAPABILITY: Partial<Record<string, Capability>> = {
  tables: "tables",
  talabat: "delivery_platforms",
  delivery: "delivery_platforms",
};

export function channelAllowedInMode(mode: BusinessMode | string, channel: string): boolean {
  const capability = CHANNEL_CAPABILITY[channel];
  return !capability || hasCapability(mode, capability);
}
