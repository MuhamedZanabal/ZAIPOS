import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

import { useTenantContext } from "@/hooks/useTenantContext";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Croissant, Beer, IceCream2, Loader2 } from "lucide-react";

type PresetProduct = {
  name: string;
  category: string;
  price: number;
  cost: number;
  tax_rate: number;
  unit_code: string;
  initial_stock: number;
};

type Preset = {
  key: "bakery" | "bar" | "icecream";
  label: string;
  description: string;
  business: { name: string; currency: string; tax_rate: number };
  categories: { name: string; color: string }[];
  products: PresetProduct[];
  tables?: { name: string; capacity: number }[];
};

const BAKERY_PRESET: Preset = {
  key: "bakery",
  label: "Bakery",
  description: "Bread, pastries, coffee, and sandwiches.",
  business: { name: "Golden Bread Bakery", currency: "COP", tax_rate: 19 },
  categories: [
    { name: "Breads", color: "#c2410c" },
    { name: "Pastries", color: "#d97706" },
    { name: "Cakes", color: "#be185d" },
    { name: "Hot drinks", color: "#7c2d12" },
    { name: "Cold drinks", color: "#0891b2" },
    { name: "Sandwiches", color: "#65a30d" },
  ],
  products: [
    { name: "French bread", category: "Breads", price: 1500, cost: 600, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Whole wheat bread", category: "Breads", price: 2500, cost: 1100, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Cheese bread", category: "Breads", price: 2000, cost: 800, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "Cassava bread", category: "Breads", price: 2200, cost: 850, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Cheese bun", category: "Breads", price: 2200, cost: 900, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Cheese fritter", category: "Breads", price: 1800, cost: 700, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "Butter croissant", category: "Pastries", price: 4500, cost: 1800, tax_rate: 19, unit_code: "unit", initial_stock: 30 },
    { name: "Chicken pastry", category: "Pastries", price: 5500, cost: 2300, tax_rate: 19, unit_code: "unit", initial_stock: 25 },
    { name: "Beef empanada", category: "Pastries", price: 3500, cost: 1400, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Cheese sticks", category: "Pastries", price: 3800, cost: 1500, tax_rate: 19, unit_code: "unit", initial_stock: 35 },
    { name: "Caramel mille-feuille", category: "Pastries", price: 6500, cost: 2600, tax_rate: 19, unit_code: "unit", initial_stock: 20 },
    { name: "Chocolate brownie", category: "Pastries", price: 5500, cost: 2100, tax_rate: 19, unit_code: "unit", initial_stock: 25 },
    { name: "Chocolate cake (slice)", category: "Cakes", price: 8000, cost: 3000, tax_rate: 19, unit_code: "unit", initial_stock: 20 },
    { name: "Carrot cake (slice)", category: "Cakes", price: 8000, cost: 3000, tax_rate: 19, unit_code: "unit", initial_stock: 18 },
    { name: "Tres leches cake (slice)", category: "Cakes", price: 8500, cost: 3200, tax_rate: 19, unit_code: "unit", initial_stock: 15 },
    { name: "Americano coffee", category: "Hot drinks", price: 3500, cost: 800, tax_rate: 19, unit_code: "unit", initial_stock: 100 },
    { name: "Coffee with milk", category: "Hot drinks", price: 4500, cost: 1200, tax_rate: 19, unit_code: "unit", initial_stock: 100 },
    { name: "Cappuccino", category: "Hot drinks", price: 5500, cost: 1500, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Hot chocolate", category: "Hot drinks", price: 5000, cost: 1400, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "Herbal tea", category: "Hot drinks", price: 3500, cost: 700, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "Orange juice", category: "Cold drinks", price: 6500, cost: 2200, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Blackberry juice", category: "Cold drinks", price: 6500, cost: 2200, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Ham and cheese sandwich", category: "Sandwiches", price: 9500, cost: 3800, tax_rate: 19, unit_code: "unit", initial_stock: 25 },
    { name: "Vegetarian sandwich", category: "Sandwiches", price: 9000, cost: 3500, tax_rate: 19, unit_code: "unit", initial_stock: 20 },
    { name: "Club sandwich", category: "Sandwiches", price: 12500, cost: 4800, tax_rate: 19, unit_code: "unit", initial_stock: 18 },
    { name: "Chicken wrap", category: "Sandwiches", price: 11000, cost: 4200, tax_rate: 19, unit_code: "unit", initial_stock: 20 },
  ],
  tables: Array.from({ length: 8 }, (_, i) => ({
    name: `Table ${i + 1}`,
    capacity: i < 4 ? 2 : 4,
  })),
};

const BAR_PRESET: Preset = {
  key: "bar",
  label: "Bar",
  description: "Beer, cocktails, spirits, and tapas.",
  business: { name: "The Hop Bar", currency: "COP", tax_rate: 19 },
  categories: [
    { name: "Beer", color: "#ca8a04" },
    { name: "Cocktails", color: "#db2777" },
    { name: "Spirits", color: "#7c3aed" },
    { name: "Wine", color: "#9f1239" },
    { name: "Tapas", color: "#dc2626" },
    { name: "Non-alcoholic", color: "#0891b2" },
  ],
  products: [
    { name: "Club Colombia Dorada", category: "Beer", price: 7000, cost: 2800, tax_rate: 19, unit_code: "unit", initial_stock: 120 },
    { name: "Águila Original", category: "Beer", price: 6000, cost: 2400, tax_rate: 19, unit_code: "unit", initial_stock: 150 },
    { name: "Poker", category: "Beer", price: 6000, cost: 2400, tax_rate: 19, unit_code: "unit", initial_stock: 130 },
    { name: "Corona Extra", category: "Beer", price: 9500, cost: 4200, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Heineken", category: "Beer", price: 9000, cost: 4000, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Stella Artois", category: "Beer", price: 9500, cost: 4300, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "BBC Cajicá", category: "Beer", price: 11000, cost: 4800, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Classic mojito", category: "Cocktails", price: 18000, cost: 6000, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Margarita", category: "Cocktails", price: 19000, cost: 6500, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Cuba Libre", category: "Cocktails", price: 16000, cost: 5500, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Aperol Spritz", category: "Cocktails", price: 22000, cost: 8000, tax_rate: 19, unit_code: "unit", initial_stock: 35 },
    { name: "Gin Tonic", category: "Cocktails", price: 22000, cost: 7500, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Piña colada", category: "Cocktails", price: 20000, cost: 7000, tax_rate: 19, unit_code: "unit", initial_stock: 35 },
    { name: "Strawberry daiquiri", category: "Cocktails", price: 19000, cost: 6500, tax_rate: 19, unit_code: "unit", initial_stock: 35 },
    { name: "Old Parr whisky (glass)", category: "Spirits", price: 18000, cost: 7000, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "Medellín 8-year rum (glass)", category: "Spirits", price: 12000, cost: 4500, tax_rate: 19, unit_code: "unit", initial_stock: 70 },
    { name: "Tequila Patrón (shot)", category: "Spirits", price: 15000, cost: 6000, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Aguardiente Antioqueño (shot)", category: "Spirits", price: 6000, cost: 2200, tax_rate: 19, unit_code: "unit", initial_stock: 100 },
    { name: "Red wine by the glass", category: "Wine", price: 14000, cost: 5500, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "White wine by the glass", category: "Wine", price: 14000, cost: 5500, tax_rate: 19, unit_code: "unit", initial_stock: 35 },
    { name: "Patatas bravas", category: "Tapas", price: 14000, cost: 4500, tax_rate: 19, unit_code: "unit", initial_stock: 30 },
    { name: "BBQ wings x6", category: "Tapas", price: 22000, cost: 9000, tax_rate: 19, unit_code: "unit", initial_stock: 25 },
    { name: "Nachos with cheese", category: "Tapas", price: 18000, cost: 6500, tax_rate: 19, unit_code: "unit", initial_stock: 30 },
    { name: "Cheese board", category: "Tapas", price: 32000, cost: 14000, tax_rate: 19, unit_code: "unit", initial_stock: 15 },
    { name: "Crispy pork belly", category: "Tapas", price: 19000, cost: 7500, tax_rate: 19, unit_code: "unit", initial_stock: 20 },
    { name: "Classic burger", category: "Tapas", price: 24000, cost: 9500, tax_rate: 19, unit_code: "unit", initial_stock: 25 },
    { name: "French fries", category: "Tapas", price: 9000, cost: 3000, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Sparkling water", category: "Non-alcoholic", price: 4500, cost: 1500, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Still water", category: "Non-alcoholic", price: 4000, cost: 1300, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Coca-Cola", category: "Non-alcoholic", price: 5000, cost: 1800, tax_rate: 19, unit_code: "unit", initial_stock: 100 },
    { name: "Sprite", category: "Non-alcoholic", price: 5000, cost: 1800, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Red Bull", category: "Non-alcoholic", price: 9500, cost: 4200, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "Passion fruit juice", category: "Non-alcoholic", price: 7000, cost: 2200, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
  ],
  tables: [
    { name: "Table 1", capacity: 4 }, { name: "Table 2", capacity: 4 },
    { name: "Table 3", capacity: 4 }, { name: "Table 4", capacity: 4 },
    { name: "Table 5", capacity: 4 }, { name: "Table 6", capacity: 4 },
    { name: "Table 7", capacity: 6 }, { name: "Table 8", capacity: 6 },
    { name: "Table 9", capacity: 6 }, { name: "Table 10", capacity: 6 },
    { name: "Table 11", capacity: 8 }, { name: "Table 12", capacity: 8 },
  ],
};

const ICECREAM_PRESET: Preset = {
  key: "icecream",
  label: "Ice Cream Shop",
  description: "Ice cream, waffles, crepes, and milkshakes.",
  business: { name: "Glacé Desserts & Ice Cream", currency: "COP", tax_rate: 19 },
  categories: [
    { name: "Ice Cream", color: "#ec4899" },
    { name: "Waffles", color: "#f59e0b" },
    { name: "Crepes", color: "#a16207" },
    { name: "Milkshakes", color: "#7c3aed" },
    { name: "Toppings", color: "#65a30d" },
    { name: "Cold drinks", color: "#0891b2" },
  ],
  products: [
    { name: "Vanilla ice cream (scoop)", category: "Ice Cream", price: 4500, cost: 1500, tax_rate: 19, unit_code: "unit", initial_stock: 120 },
    { name: "Chocolate ice cream (scoop)", category: "Ice Cream", price: 4500, cost: 1500, tax_rate: 19, unit_code: "unit", initial_stock: 120 },
    { name: "Strawberry ice cream (scoop)", category: "Ice Cream", price: 4500, cost: 1500, tax_rate: 19, unit_code: "unit", initial_stock: 100 },
    { name: "Blackberry ice cream (scoop)", category: "Ice Cream", price: 4500, cost: 1500, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Caramel ice cream (scoop)", category: "Ice Cream", price: 5000, cost: 1700, tax_rate: 19, unit_code: "unit", initial_stock: 100 },
    { name: "Three-flavor sundae", category: "Ice Cream", price: 12000, cost: 4500, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "Banana split", category: "Ice Cream", price: 16000, cost: 6000, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Chocolate sundae", category: "Ice Cream", price: 13000, cost: 4800, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Classic waffle", category: "Waffles", price: 12000, cost: 4200, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Nutella & strawberry waffle", category: "Waffles", price: 17000, cost: 6500, tax_rate: 19, unit_code: "unit", initial_stock: 35 },
    { name: "Tropical fruit waffle", category: "Waffles", price: 16000, cost: 6000, tax_rate: 19, unit_code: "unit", initial_stock: 30 },
    { name: "Ice cream & caramel waffle", category: "Waffles", price: 18000, cost: 6800, tax_rate: 19, unit_code: "unit", initial_stock: 30 },
    { name: "Nutella banana crepe", category: "Crepes", price: 15000, cost: 5500, tax_rate: 19, unit_code: "unit", initial_stock: 30 },
    { name: "Chicken mushroom crepe", category: "Crepes", price: 17000, cost: 7000, tax_rate: 19, unit_code: "unit", initial_stock: 25 },
    { name: "Caramel cheese crepe", category: "Crepes", price: 14000, cost: 5000, tax_rate: 19, unit_code: "unit", initial_stock: 30 },
    { name: "Red berry crepe", category: "Crepes", price: 16000, cost: 6000, tax_rate: 19, unit_code: "unit", initial_stock: 25 },
    { name: "Oreo milkshake", category: "Milkshakes", price: 13000, cost: 4500, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Strawberry milkshake", category: "Milkshakes", price: 12000, cost: 4000, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Chocolate milkshake", category: "Milkshakes", price: 12000, cost: 4000, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Brownie milkshake", category: "Milkshakes", price: 14000, cost: 5000, tax_rate: 19, unit_code: "unit", initial_stock: 40 },
    { name: "Vanilla milkshake", category: "Milkshakes", price: 11000, cost: 3500, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Chocolate sprinkles topping", category: "Toppings", price: 2000, cost: 500, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Topping M&M", category: "Toppings", price: 3000, cost: 1000, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "Brownie pieces topping", category: "Toppings", price: 3500, cost: 1200, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Fresh strawberries topping", category: "Toppings", price: 4000, cost: 1500, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Caramel sauce", category: "Toppings", price: 2500, cost: 800, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Chocolate sauce", category: "Toppings", price: 2500, cost: 800, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Caramel sauce", category: "Toppings", price: 2500, cost: 800, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Fresh lemonade", category: "Cold drinks", price: 6000, cost: 2000, tax_rate: 19, unit_code: "unit", initial_stock: 60 },
    { name: "Coconut lemonade", category: "Cold drinks", price: 8500, cost: 3000, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Cherry lemonade", category: "Cold drinks", price: 7500, cost: 2500, tax_rate: 19, unit_code: "unit", initial_stock: 50 },
    { name: "Coca-Cola", category: "Cold drinks", price: 5000, cost: 1800, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
    { name: "Still water", category: "Cold drinks", price: 4000, cost: 1300, tax_rate: 19, unit_code: "unit", initial_stock: 80 },
  ],
  tables: Array.from({ length: 10 }, (_, i) => ({
    name: `Table ${i + 1}`,
    capacity: i < 6 ? 2 : 4,
  })),
};

const PRESETS: Record<"bakery" | "bar" | "icecream", Preset> = {
  bakery: BAKERY_PRESET,
  bar: BAR_PRESET,
  icecream: ICECREAM_PRESET,
};

const PRESET_ICONS = {
  bakery: Croissant,
  bar: Beer,
  icecream: IceCream2,
};

// Utilidades aleatorias
const rnd = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
const pickN = <T,>(arr: T[], n: number) => {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
};

export default function DemoPresets() {
  const { tenantId, branchId, hasRole } = useTenantContext();
  const qc = useQueryClient();
  const canEdit = hasRole("owner", "admin");
  const [pending, setPending] = useState<null | "bakery" | "bar" | "icecream">(null);
  const [confirmKind, setConfirmKind] = useState<null | "bakery" | "bar" | "icecream">(null);
  const [generateLive, setGenerateLive] = useState(true);

  if (!canEdit) return null;

  const generateLiveData = async (
    preset: Preset,
    productMap: Map<string, { id: string; price: number; tax_rate: number; product_type: string }>,
  ) => {
    if (!tenantId || !branchId) return { openOrders: 0, historicSales: 0, deliveries: 0 };
    let user;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error();
      user = session.user;
    } catch {
      return { openOrders: 0, historicSales: 0, deliveries: 0 };
    }

    // 1) Asegurar caja abierta hoy
    let { data: openSession } = await supabase
      .from("cash_sessions")
      .select("id")
      .eq("branch_id", branchId)
      .eq("status", "open")
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!openSession) {
      const { data: newSession } = await supabase
        .from("cash_sessions")
        .insert({
          tenant_id: tenantId,
          branch_id: branchId,
          user_id: user.id,
          opening_amount: 200000,
          status: "open",
        })
        .select("id")
        .single();
      openSession = newSession;
    }

    // 2) Pedidos abiertos en mesas
    const { data: branchTables } = await supabase
      .from("tables")
      .select("id, name, status")
      .eq("tenant_id", tenantId)
      .eq("branch_id", branchId)
      .eq("status", "available")
      .order("sort_order");

    const products = Array.from(productMap.values());
    let openOrders = 0;

    if (branchTables && branchTables.length > 0 && products.length > 0) {
      const tablesToOccupy = pickN(branchTables, Math.min(branchTables.length, rnd(4, 6)));
      for (const t of tablesToOccupy) {
        const { data: order } = await supabase
          .from("table_orders")
          .insert({
            tenant_id: tenantId,
            branch_id: branchId,
            table_id: t.id,
            waiter_id: user.id,
            guests: rnd(1, 4),
            status: "open",
            notes: "[demo]",
          })
          .select("id")
          .single();
        if (!order) continue;

        await supabase.from("tables").update({ status: "occupied" }).eq("id", t.id);

        const itemCount = rnd(2, 5);
        const itemsToInsert = pickN(products, itemCount).map((p) => {
          const qty = rnd(1, 3);
          const sub = qty * p.price;
          const tax = (sub * p.tax_rate) / 100;
          return {
            tenant_id: tenantId,
            order_id: order.id,
            product_id: p.id,
            product_name: products.find((pp) => pp.id === p.id)
              ? Array.from(productMap.entries()).find(([, v]) => v.id === p.id)?.[0] ?? "Product"
              : "Product",
            product_type: p.product_type as any,
            quantity: qty,
            unit_price: p.price,
            tax_rate: p.tax_rate,
            discount: 0,
            line_total: sub + tax,
            status: "pending" as const,
          };
        });

        const { data: insertedItems } = await supabase
          .from("table_order_items")
          .insert(itemsToInsert)
          .select("id");

        // Distribuir items en estados realistas: pending → preparing → ready → dispatched
        if (insertedItems) {
          for (const it of insertedItems) {
            const r = Math.random();
            if (r < 0.25) {
              // queda pending
            } else if (r < 0.55) {
              await supabase.rpc("start_preparing_table_item", { _item_id: it.id });
            } else if (r < 0.80) {
              await supabase.rpc("start_preparing_table_item", { _item_id: it.id });
              await supabase.rpc("mark_table_item_ready", { _item_id: it.id });
            } else {
              await supabase.rpc("dispatch_table_item", { _item_id: it.id });
            }
          }
        }

        await supabase.rpc("recalc_table_order", { _order_id: order.id });
        openOrders++;
      }
    }

    // 3) Ventas históricas (últimos 7 días)
    const methods: Array<"cash" | "card" | "transfer" | "qr"> = ["cash", "card", "transfer", "qr"];
    let historicSales = 0;

    for (let d = 7; d >= 1; d--) {
      const day = new Date();
      day.setDate(day.getDate() - d);
      day.setHours(8, 0, 0, 0);
      const closeTs = new Date(day);
      closeTs.setHours(22, 0, 0, 0);

      // Crear sesión cerrada del día
      const { data: histSession } = await supabase
        .from("cash_sessions")
        .insert({
          tenant_id: tenantId,
          branch_id: branchId,
          user_id: user.id,
          opening_amount: 200000,
          status: "closed",
          opened_at: day.toISOString(),
          closed_at: closeTs.toISOString(),
          notes: "[demo]",
        })
        .select("id")
        .single();
      if (!histSession) continue;

      const salesPerDay = rnd(5, 9);
      let totalCash = 0, totalCard = 0, totalTransfer = 0, totalQr = 0;

      for (let s = 0; s < salesPerDay; s++) {
        const saleHour = rnd(9, 21);
        const saleMin = rnd(0, 59);
        const saleTs = new Date(day);
        saleTs.setHours(saleHour, saleMin, 0, 0);

        const items = pickN(products, rnd(1, 4));
        let subtotal = 0, taxTotal = 0;
        const saleItems: any[] = [];
        for (const p of items) {
          const qty = rnd(1, 3);
          const sub = qty * p.price;
          const tax = (sub * p.tax_rate) / 100;
          subtotal += sub;
          taxTotal += tax;
          const name = Array.from(productMap.entries()).find(([, v]) => v.id === p.id)?.[0] ?? "Product";
          saleItems.push({
            tenant_id: tenantId,
            product_id: p.id,
            product_name: name,
            product_type: p.product_type,
            quantity: qty,
            unit_price: p.price,
            tax_rate: p.tax_rate,
            discount: 0,
            line_total: sub + tax,
          });
        }
        const total = subtotal + taxTotal;

        const { data: sale } = await supabase
          .from("sales")
          .insert({
            tenant_id: tenantId,
            branch_id: branchId,
            session_id: histSession.id,
            user_id: user.id,
            subtotal,
            tax_total: taxTotal,
            discount_total: 0,
            total,
            status: "completed",
            channel: "pos",
            notes: "[demo]",
            created_at: saleTs.toISOString(),
          })
          .select("id")
          .single();
        if (!sale) continue;

        await supabase
          .from("sale_items")
          .insert(saleItems.map((it) => ({ ...it, sale_id: sale.id })));

        const method = pick(methods);
        await supabase.from("payments").insert({
          tenant_id: tenantId,
          sale_id: sale.id,
          method,
          amount: total,
        });
        if (method === "cash") totalCash += total;
        else if (method === "card") totalCard += total;
        else if (method === "transfer") totalTransfer += total;
        else if (method === "qr") totalQr += total;

        historicSales++;
      }

      // Actualizar totales de la sesión cerrada
      const expected = 200000 + totalCash;
      await supabase
        .from("cash_sessions")
        .update({
          total_cash: totalCash,
          total_card: totalCard,
          total_transfer: totalTransfer,
          total_qr: totalQr,
          expected_amount: expected,
          closing_amount: expected,
          difference: 0,
        })
        .eq("id", histSession.id);
    }

    // 4) Pedidos de delivery
    const deliveryNames = ["Carlos Pérez", "María Gómez", "Andrés Ruiz", "Laura Torres", "Diego Méndez", "Sofía Ramírez", "Juan Castro", "Camila Vega"];
    const deliveryHoods = ["Chapinero", "Usaquén", "Cedritos", "Modelia", "Salitre", "Suba", "Country", "Macarena"];
    const deliveryStatus: Array<"received" | "preparing" | "on_way" | "delivered"> = ["received", "preparing", "on_way", "delivered", "delivered", "delivered"];
    let deliveries = 0;

    for (let i = 0; i < rnd(5, 8); i++) {
      const items = pickN(products, rnd(1, 3));
      let subtotal = 0, taxTotal = 0;
      const saleItems: any[] = [];
      for (const p of items) {
        const qty = rnd(1, 2);
        const sub = qty * p.price;
        const tax = (sub * p.tax_rate) / 100;
        subtotal += sub;
        taxTotal += tax;
        const name = Array.from(productMap.entries()).find(([, v]) => v.id === p.id)?.[0] ?? "Product";
        saleItems.push({
          tenant_id: tenantId,
          product_id: p.id,
          product_name: name,
          product_type: p.product_type,
          quantity: qty,
          unit_price: p.price,
          tax_rate: p.tax_rate,
          discount: 0,
          line_total: sub + tax,
        });
      }
      const fee = 5000;
      const total = subtotal + taxTotal;
      const createdTs = new Date();
      createdTs.setHours(createdTs.getHours() - rnd(1, 48));

      const { data: sale } = await supabase
        .from("sales")
        .insert({
          tenant_id: tenantId,
          branch_id: branchId,
          user_id: user.id,
          subtotal,
          tax_total: taxTotal,
          discount_total: 0,
          total,
          status: "completed",
          channel: "delivery",
          notes: "[demo]",
          created_at: createdTs.toISOString(),
        })
        .select("id")
        .single();
      if (!sale) continue;

      await supabase
        .from("sale_items")
        .insert(saleItems.map((it) => ({ ...it, sale_id: sale.id })));

      const status = pick(deliveryStatus);
      await supabase.from("delivery_orders").insert({
        tenant_id: tenantId,
        branch_id: branchId,
        customer_name: pick(deliveryNames),
        customer_phone: `300${rnd(1000000, 9999999)}`,
        address: `Street ${rnd(10, 180)} # ${rnd(1, 90)}-${rnd(1, 99)}`,
        neighborhood: pick(deliveryHoods),
        delivery_fee: fee,
        status,
        sale_id: sale.id,
        user_id: user.id,
        notes: "[demo]",
      });
      deliveries++;
    }

    return { openOrders, historicSales, deliveries };
  };

  const applyPreset = async (kind: "bakery" | "bar" | "icecream") => {
    if (!tenantId) return toast.error("Select a business first");
    if (!branchId) return toast.error("Select a branch first");
    const preset = PRESETS[kind];
    setPending(kind);

    try {
      // 1. Update tenant
      const { error: tErr } = await supabase
        .from("tenants")
        .update(preset.business)
        .eq("id", tenantId);
      if (tErr) throw tErr;

      // 2. Categorías
      const { data: existingCats } = await supabase
        .from("categories")
        .select("id, name")
        .eq("tenant_id", tenantId);
      const existingCatMap = new Map((existingCats ?? []).map((c) => [c.name, c.id]));

      const catsToInsert = preset.categories.filter((c) => !existingCatMap.has(c.name));
      let createdCats = 0;
      if (catsToInsert.length > 0) {
        const { data: ins, error: cErr } = await supabase
          .from("categories")
          .insert(catsToInsert.map((c, i) => ({
            tenant_id: tenantId,
            name: c.name,
            color: c.color,
            sort_order: i,
          })))
          .select("id, name");
        if (cErr) throw cErr;
        createdCats = ins?.length ?? 0;
        ins?.forEach((c) => existingCatMap.set(c.name, c.id));
      }

      // 3. Productos
      const { data: existingProducts } = await supabase
        .from("products")
        .select("id, name, price, tax_rate, product_type")
        .eq("tenant_id", tenantId);
      const existingProdMap = new Map(
        (existingProducts ?? []).map((p) => [p.name, p])
      );

      const productsToInsert = preset.products
        .filter((p) => !existingProdMap.has(p.name))
        .map((p) => ({
          tenant_id: tenantId,
          category_id: existingCatMap.get(p.category) ?? null,
          name: p.name,
          product_type: "simple" as const,
          unit_code: p.unit_code,
          price: p.price,
          cost: p.cost,
          tax_rate: p.tax_rate,
          min_stock: 5,
        }));

      let createdProds: { id: string; name: string; price: number; tax_rate: number; product_type: string }[] = [];
      if (productsToInsert.length > 0) {
        const { data: ins, error: pErr } = await supabase
          .from("products")
          .insert(productsToInsert)
          .select("id, name, price, tax_rate, product_type");
        if (pErr) throw pErr;
        createdProds = ins ?? [];
      }

      // Mapa nombre -> producto (existentes + nuevos), filtrado a los del preset
      const presetNames = new Set(preset.products.map((p) => p.name));
      const productMap = new Map<string, { id: string; price: number; tax_rate: number; product_type: string }>();
      for (const [name, p] of existingProdMap.entries()) {
        if (presetNames.has(name)) {
          productMap.set(name, { id: p.id, price: Number(p.price), tax_rate: Number(p.tax_rate), product_type: p.product_type });
        }
      }
      for (const p of createdProds) {
        productMap.set(p.name, { id: p.id, price: Number(p.price), tax_rate: Number(p.tax_rate), product_type: p.product_type });
      }

      // 4. Stock inicial
      let user;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user) throw new Error();
        user = session.user;
      } catch {
        throw new Error("There is no active session to apply stock");
      }

      // Consultar stock actual de todos los productos del preset
      const { data: currentStocks } = await supabase
        .from("inventory_stocks")
        .select("product_id, quantity")
        .in("product_id", Array.from(productMap.values()).map(p => p.id))
        .eq("branch_id", branchId);
      
      const stockMap = new Map(preset.products.map((p) => [p.name, p.initial_stock]));
      const existingStockIds = new Set((currentStocks ?? []).filter(s => Number(s.quantity) > 0).map(s => s.product_id));
      
      let stocked = 0;
      for (const [name, prod] of productMap.entries()) {
        const qty = stockMap.get(name) ?? 0;
        // Solo aprovisionar si no tiene stock positivo previo
        if (qty > 0 && user && !existingStockIds.has(prod.id)) {
          const { error: mErr } = await supabase.rpc("apply_inventory_movement", {
            _tenant_id: tenantId,
            _branch_id: branchId,
            _product_id: prod.id,
            _movement_type: "purchase",
            _quantity: qty,
            _reason: `Demo seed (${kind})`,
            _reference_type: "demo_preset",
            _reference_id: prod.id,
            _user_id: user.id,
          });
          if (!mErr) stocked++;
        }
      }

      // 5. Mesas
      let createdTables = 0;
      if (preset.tables) {
        const { data: existingTables } = await supabase
          .from("tables")
          .select("name")
          .eq("tenant_id", tenantId)
          .eq("branch_id", branchId);
        const existingTableNames = new Set((existingTables ?? []).map((t) => t.name));
        const tablesToInsert = preset.tables
          .filter((t) => !existingTableNames.has(t.name))
          .map((t, i) => ({
            tenant_id: tenantId,
            branch_id: branchId,
            name: t.name,
            capacity: t.capacity,
            sort_order: i,
          }));
        if (tablesToInsert.length > 0) {
          const { data: ins, error: tErr2 } = await supabase
            .from("tables")
            .insert(tablesToInsert)
            .select("id");
          if (tErr2) throw tErr2;
          createdTables = ins?.length ?? 0;
        }
      }

      // 6. Datos vivos (opcional)
      let live = { openOrders: 0, historicSales: 0, deliveries: 0 };
      if (generateLive) {
        live = await generateLiveData(preset, productMap);
      }

      const liveTxt = generateLive
        ? `, ${live.openOrders} tables with orders, ${live.historicSales} demo sales, ${live.deliveries} deliveries`
        : "";
      toast.success(
        `Demo "${preset.business.name}" applied: ${createdCats} categories, ${createdProds.length} products, ${stocked} stocked${createdTables ? `, ${createdTables} tables` : ""}${liveTxt}.`
      );

      qc.invalidateQueries();
    } catch (err: any) {
      toast.error(err.message ?? "Error applying demo");
    } finally {
      setPending(null);
      setConfirmKind(null);
    }
  };

  const presetList: Preset[] = [BAKERY_PRESET, BAR_PRESET, ICECREAM_PRESET];

  return (
    <div className="glass p-6 space-y-4 border-dashed">
      <div>
        <h3 className="font-semibold">Demo templates</h3>
        <p className="text-sm text-muted-foreground">
          Apply a complete preset (rebranding, categories, products, stock, tables)
          to the active business and branch. It is idempotent and does not duplicate existing data.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {presetList.map((p) => {
          const Icon = PRESET_ICONS[p.key];
          return (
            <button
              key={p.key}
              type="button"
              disabled={!!pending}
              onClick={() => setConfirmKind(p.key)}
              className="text-left rounded-lg border p-4 hover:border-primary hover:bg-accent/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2 mb-2">
                {pending === p.key ? (
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                ) : (
                  <Icon className="h-5 w-5 text-primary" />
                )}
                <span className="font-medium">{p.label}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-2">{p.description}</p>
              <p className="text-xs text-muted-foreground">
                {p.categories.length} categories · {p.products.length} products
                {p.tables ? ` · ${p.tables.length} tables` : ""}
              </p>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 pt-2 border-t">
        <Switch id="live-data" checked={generateLive} onCheckedChange={setGenerateLive} />
        <Label htmlFor="live-data" className="text-sm cursor-pointer">
          Generate live data: tables with open orders + 7 days of sales + deliveries
        </Label>
      </div>

      <AlertDialog open={!!confirmKind} onOpenChange={(o) => !o && setConfirmKind(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Apply {confirmKind ? PRESETS[confirmKind].label : ""} demo?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  The business name will be changed to{" "}
                  <strong>{confirmKind ? PRESETS[confirmKind].business.name : ""}</strong>{" "}
                  and categories, products, opening stock, and tables will be added to the active branch.
                </p>
                {generateLive && (
                  <p className="text-foreground">
                    The following will also be generated: <strong>4–6 occupied tables</strong> con pedidos abiertos,{" "}
                    <strong>~50 sales</strong> from the last 7 days with a closed register for each day, and{" "}
                    <strong>5–8 deliveries</strong>.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmKind && applyPreset(confirmKind)}>
              Aplicar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
