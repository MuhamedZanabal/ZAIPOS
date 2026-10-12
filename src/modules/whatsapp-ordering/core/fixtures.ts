import type { CatalogItem } from "./types";

/** Sample Bahrain restaurant menu used by tests and the simulator (prices VAT-exclusive). */
export const SAMPLE_CATALOG: CatalogItem[] = [
  { productId: "p-shawarma", nameEn: "Chicken Shawarma", nameAr: "شاورما دجاج", category: "Sandwiches", categoryAr: "سندويشات", priceFils: 800, taxRatePct: 10, available: true, stock: null,
    aliases: ["shawarma", "شاورما", "شورما"], modifiers: [{ name: "no onion", nameAr: "بدون بصل", priceFils: 0 }, { name: "extra garlic", nameAr: "ثوم زياده", priceFils: 100 }] },
  { productId: "p-falafel", nameEn: "Falafel Wrap", nameAr: "لفافة فلافل", category: "Sandwiches", categoryAr: "سندويشات", priceFils: 500, taxRatePct: 10, available: true, stock: null,
    aliases: ["falafel", "فلافل"] },
  { productId: "p-machboos", nameEn: "Chicken Machboos", nameAr: "مجبوس دجاج", category: "Mains", categoryAr: "أطباق رئيسية", priceFils: 2500, taxRatePct: 10, available: true, stock: 5,
    aliases: ["machboos", "majboos", "مجبوس", "مچبوس"] },
  { productId: "p-karak", nameEn: "Karak Tea", nameAr: "شاي كرك", category: "Drinks", categoryAr: "مشروبات", priceFils: 200, taxRatePct: 10, available: true, stock: null,
    aliases: ["karak", "كرك", "chai karak"] },
  { productId: "p-lemon", nameEn: "Lemon Mint", nameAr: "ليمون نعناع", category: "Drinks", categoryAr: "مشروبات", priceFils: 900, taxRatePct: 10, available: true, stock: null,
    aliases: ["lemon mint", "ليمون بالنعناع"] },
];
