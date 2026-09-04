const now = new Date();
const isoNow = now.toISOString();

export const fixtureTenantId = "11111111-1111-4111-8111-111111111111";
export const fixtureBranchId = "22222222-2222-4222-8222-222222222222";
const fixtureUserId = "33333333-3333-4333-8333-333333333333";

const tenant = {
  id: fixtureTenantId,
  name: "ZAIPOS Bahrain Demo",
  domain: "demo.localhost",
  logo_url: null,
  primary_color: "#1E63E6",
  theme_kind: "bar",
  currency: "BHD",
  tax_rate: 10,
  active_channels: ["pos", "tables", "talabat", "whatsapp", "delivery"],
  dev_mode: false,
  receipt_config: {
    business_name: "ZAIPOS Bahrain Demo",
    address: "Amwaj Islands, Muharraq, Bahrain",
    phone: "+973 1700 0000",
    footer: "Thank you for shopping with us",
  },
};

const branch = {
  id: fixtureBranchId,
  tenant_id: fixtureTenantId,
  name: "Amwaj Islands",
  code: "AMW",
  status: "active",
  address: "Amwaj Islands, Muharraq, Bahrain",
  phone: "+973 1700 0000",
};

const user = {
  id: fixtureUserId,
  aud: "authenticated",
  role: "authenticated",
  email: "owner@zaipos.local",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { name: "ZAIPOS Owner" },
  created_at: isoNow,
};

const categories = [
  { id: "cat-dairy", name: "Dairy", color: "#D7ECFF", schedule_enabled: false, schedule_from: null, schedule_until: null, schedule_days: null, status: "active", sort_order: 1 },
  { id: "cat-bakery", name: "Bakery", color: "#F8E1C1", schedule_enabled: false, schedule_from: null, schedule_until: null, schedule_days: null, status: "active", sort_order: 2 },
  { id: "cat-drinks", name: "Drinks", color: "#DDF4E4", schedule_enabled: false, schedule_from: null, schedule_until: null, schedule_days: null, status: "active", sort_order: 3 },
  { id: "cat-grocery", name: "Grocery", color: "#F0E2FF", schedule_enabled: false, schedule_from: null, schedule_until: null, schedule_days: null, status: "active", sort_order: 4 },
];

const products = [
  { id: "p-milk", tenant_id: fixtureTenantId, name: "Almarai Fresh Milk 1L", price: 0.650, tax_rate: 10, category_id: "cat-dairy", image_url: null, sku: "MILK-1L", barcode: "6281007023310", status: "active", product_type: "standard", station: null, description: "Fresh full-fat milk", sort_order: 1, color: "#D7ECFF" },
  { id: "p-water", tenant_id: fixtureTenantId, name: "Bahrain Water 1.5L", price: 0.250, tax_rate: 10, category_id: "cat-drinks", image_url: null, sku: "WATER-15", barcode: "6291100130014", status: "active", product_type: "standard", station: null, description: "Bottled drinking water", sort_order: 2, color: "#DDF4E4" },
  { id: "p-bread", tenant_id: fixtureTenantId, name: "Arabic Bread Pack", price: 0.300, tax_rate: 0, category_id: "cat-bakery", image_url: null, sku: "BREAD-AR", barcode: "6291100991011", status: "active", product_type: "standard", station: null, description: "Fresh Arabic bread", sort_order: 3, color: "#F8E1C1" },
  { id: "p-dates", tenant_id: fixtureTenantId, name: "Premium Dates 500g", price: 2.250, tax_rate: 10, category_id: "cat-grocery", image_url: null, sku: "DATES-500", barcode: "6291100991028", status: "active", product_type: "standard", station: null, description: "Premium dates", sort_order: 4, color: "#F0E2FF" },
  { id: "p-karak", tenant_id: fixtureTenantId, name: "Karak Tea", price: 0.350, tax_rate: 10, category_id: "cat-drinks", image_url: null, sku: "KARAK", barcode: null, status: "active", product_type: "standard", station: "kitchen", description: "Fresh karak tea", sort_order: 5, color: "#DDF4E4" },
  { id: "p-labneh", tenant_id: fixtureTenantId, name: "Labneh 200g", price: 0.750, tax_rate: 10, category_id: "cat-dairy", image_url: null, sku: "LABNEH-200", barcode: "6291100991035", status: "active", product_type: "standard", station: null, description: "Fresh labneh", sort_order: 6, color: "#D7ECFF" },
  { id: "p-juice", tenant_id: fixtureTenantId, name: "Fresh Orange Juice", price: 1.100, tax_rate: 10, category_id: "cat-drinks", image_url: null, sku: "OJ-500", barcode: "6291100991042", status: "active", product_type: "standard", station: null, description: "Fresh orange juice", sort_order: 7, color: "#DDF4E4" },
  { id: "p-croissant", tenant_id: fixtureTenantId, name: "Cheese Croissant", price: 0.900, tax_rate: 10, category_id: "cat-bakery", image_url: null, sku: "CROISSANT-C", barcode: null, status: "active", product_type: "standard", station: "kitchen", description: "Fresh cheese croissant", sort_order: 8, color: "#F8E1C1" },
];

const inventoryStocks = products.map((product, index) => ({ product_id: product.id, quantity: index === 1 ? 3 : 18 + index * 7 }));
const nestedInventoryStocks = products.map((product, index) => ({
  quantity: index === 1 ? 3 : 18 + index * 7,
  products: { id: product.id, name: product.name, min_stock: 5, status: "active", color: product.color },
}));

const branchProducts = products.map((product) => ({
  product_id: product.id,
  branch_id: fixtureBranchId,
  is_available: true,
  local_price: null,
}));

const channelPrices = [
  { product_id: "p-karak", branch_id: fixtureBranchId, channel: "talabat", price: 0.450 },
  { product_id: "p-croissant", branch_id: fixtureBranchId, channel: "talabat", price: 1.050 },
];

const customers = [
  { id: "c-1", name: "Fatima Ali", phone: "+97336001234", document_number: "900001234", loyalty_points: 420 },
  { id: "c-2", name: "Ahmed Hassan", phone: "+97339004567", document_number: "910004567", loyalty_points: 180 },
  { id: "c-3", name: "Noor Mohammed", phone: "+97333007890", document_number: "920007890", loyalty_points: 95 },
];

const cashSession = {
  id: "session-1",
  opening_amount: 75.000,
  total_cash: 96.450,
  total_card: 128.650,
  total_transfer: 18.250,
  total_qr: 84.750,
  total_in: 0,
  total_out: 6.500,
  opened_at: isoNow,
  status: "open",
};

const recentSales = [
  { id: "sale-1", ticket_number: "AMW-1048", total: 12.650, created_at: new Date(Date.now() - 5 * 60000).toISOString(), channel: "pos", status: "completed", payments: [{ method: "card", amount: 12.650 }] },
  { id: "sale-2", ticket_number: "AMW-1047", total: 7.200, created_at: new Date(Date.now() - 12 * 60000).toISOString(), channel: "talabat", status: "completed", payments: [{ method: "qr", amount: 7.200 }] },
  { id: "sale-3", ticket_number: "AMW-1046", total: 4.850, created_at: new Date(Date.now() - 21 * 60000).toISOString(), channel: "pos", status: "completed", payments: [{ method: "cash", amount: 4.850 }] },
  { id: "sale-4", ticket_number: "AMW-1045", total: 9.400, created_at: new Date(Date.now() - 36 * 60000).toISOString(), channel: "whatsapp", status: "completed", payments: [{ method: "transfer", amount: 9.400 }] },
];

const sales = recentSales.concat([
  { id: "sale-5", total: 18.700, created_at: isoNow, status: "completed" },
  { id: "sale-6", total: 6.300, created_at: isoNow, status: "completed" },
  { id: "sale-7", total: 21.100, created_at: isoNow, status: "completed" },
]);

const payments = [
  { method: "cash", amount: 96.450, sales: { branch_id: fixtureBranchId, created_at: isoNow, status: "completed" } },
  { method: "card", amount: 128.650, sales: { branch_id: fixtureBranchId, created_at: isoNow, status: "completed" } },
  { method: "qr", amount: 84.750, sales: { branch_id: fixtureBranchId, created_at: isoNow, status: "completed" } },
  { method: "transfer", amount: 18.250, sales: { branch_id: fixtureBranchId, created_at: isoNow, status: "completed" } },
];

const digitalOrders = [
  {
    id: "do-1", channel: "talabat", external_order_number: "TB-2048", gross_total: 8.750,
    platform_commission: 1.313, net_total: 7.437, status: "pending", external_status: "new",
    delivery_address: "Amwaj Islands, Muharraq, Bahrain", notes: "Customer: Fatima · Phone: +973 3600 1234",
    sale_id: null, table_id: null, created_at: new Date(Date.now() - 8 * 60000).toISOString(),
    digital_order_items: [
      { id: "doi-1", product_name: "Karak Tea", quantity: 2, unit_price: 0.450, tax_rate: 10, line_total: 0.900 },
      { id: "doi-2", product_name: "Cheese Croissant", quantity: 2, unit_price: 1.050, tax_rate: 10, line_total: 2.100 },
      { id: "doi-3", product_name: "Premium Dates 500g", quantity: 1, unit_price: 2.250, tax_rate: 10, line_total: 2.250 },
    ],
    tables: null,
  },
  {
    id: "do-2", channel: "whatsapp", external_order_number: "WA-1182", gross_total: 5.600,
    platform_commission: 0, net_total: 5.600, status: "pending", external_status: "received",
    delivery_address: "Juffair, Manama, Bahrain", notes: "Customer: Ahmed · Phone: +973 3900 4567",
    sale_id: null, table_id: null, created_at: new Date(Date.now() - 18 * 60000).toISOString(),
    digital_order_items: [
      { id: "doi-4", product_name: "Fresh Orange Juice", quantity: 2, unit_price: 1.100, tax_rate: 10, line_total: 2.200 },
      { id: "doi-5", product_name: "Arabic Bread Pack", quantity: 2, unit_price: 0.300, tax_rate: 0, line_total: 0.600 },
    ],
    tables: null,
  },
];

const tables = [
  { id: "table-1", name: "Table 1", status: "available" },
  { id: "table-2", name: "Table 2", status: "occupied" },
];

function tableData(table: string, selectText: string) {
  switch (table) {
    case "tenants": return tenant;
    case "user_roles": return [{ tenant_id: fixtureTenantId, role: "owner", branch_id: null, tenants: tenant }];
    case "branches": return [branch];
    case "categories": return categories;
    case "products": return products;
    case "inventory_stocks": return selectText.includes("products!inner") ? nestedInventoryStocks : inventoryStocks;
    case "branch_products": return branchProducts;
    case "product_channel_prices": return channelPrices;
    case "customers": return customers;
    case "cash_sessions": return cashSession;
    case "sales": return selectText.includes("ticket_number") ? recentSales : sales;
    case "payments": return payments;
    case "production_orders": return [{ id: "prod-1", produced_quantity: 42 }];
    case "digital_orders": return digitalOrders;
    case "tables": return tables;
    case "table_orders": return [];
    default: return [];
  }
}

class MockQuery {
  private selectText = "";
  private wantsCount = false;
  private headOnly = false;
  constructor(private table: string) {}

  select(columns = "*", options: { count?: string; head?: boolean } = {}) {
    this.selectText = columns;
    this.wantsCount = Boolean(options.count);
    this.headOnly = Boolean(options.head);
    return this;
  }

  eq() { return this; }
  neq() { return this; }
  gte() { return this; }
  lte() { return this; }
  gt() { return this; }
  lt() { return this; }
  in() { return this; }
  is() { return this; }
  not() { return this; }
  or() { return this; }
  ilike() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  update() { return this; }
  insert() { return this; }
  upsert() { return this; }
  delete() { return this; }

  private result(single = false) {
    const raw = tableData(this.table, this.selectText);
    if (this.headOnly) return { data: null, error: null, count: Array.isArray(raw) ? raw.length : raw ? 1 : 0 };
    const data = single ? (Array.isArray(raw) ? raw[0] ?? null : raw) : (Array.isArray(raw) ? raw : [raw]);
    return { data, error: null, count: this.wantsCount ? (Array.isArray(raw) ? raw.length : raw ? 1 : 0) : null };
  }

  maybeSingle() { return Promise.resolve(this.result(true)); }
  single() { return Promise.resolve(this.result(true)); }

  then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve(this.result(false)).then(resolve, reject);
  }
}

const noopSubscription = { unsubscribe() {} };

export const supabase = {
  from(table: string) { return new MockQuery(table); },
  rpc() { return Promise.resolve({ data: null, error: null }); },
  auth: {
    getSession: async () => ({ data: { session: { user } }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: noopSubscription } }),
    signOut: async () => ({ error: null }),
  },
  channel() {
    const channel = {
      on() { return channel; },
      subscribe() { return channel; },
    };
    return channel;
  },
  removeChannel: async () => ({ status: "ok" }),
};
