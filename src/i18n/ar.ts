/**
 * Arabic UI strings keyed by the English source text. Missing keys fall back to English,
 * so screens stay usable while translation coverage grows.
 */
export const AR: Record<string, string> = {
  // navigation
  "Operations": "العمليات", "Catalog": "الكتالوج", "Stock": "المخزون", "Business": "الأعمال",
  "Dashboard": "لوحة التحكم", "POS": "نقطة البيع", "Tables": "الطاولات", "Waiter": "النادل", "Delivery": "التوصيل",
  "Courier": "المندوب", "Cash Register": "الصندوق", "Sales": "المبيعات", "Customers": "العملاء", "Products": "المنتجات",
  "Pricing policies": "سياسات التسعير", "Recipes": "الوصفات", "Inventory": "المخزون", "Production": "الإنتاج",
  "Kitchen KDS": "شاشة المطبخ", "Suppliers": "الموردون", "Employees": "الموظفون", "Schedules": "الجداول",
  "Reports": "التقارير", "Settings": "الإعدادات", "Sign out": "تسجيل الخروج", "Language": "اللغة",
  // POS
  "Search products": "ابحث عن المنتجات", "Scan barcode": "امسح الباركود", "Register open": "الصندوق مفتوح",
  "Register closed": "الصندوق مغلق", "No register": "لا يوجد صندوق", "Open register": "افتح الصندوق",
  "Open register to charge": "افتح الصندوق للتحصيل", "Add products to the ticket": "أضف منتجات إلى الفاتورة",
  "Sales today": "مبيعات اليوم", "Tickets": "الفواتير", "Avg ticket": "متوسط الفاتورة", "Channel": "القناة",
  "No products found": "لا توجد منتجات", "Weight (kg)": "الوزن (كغ)", "Add to sale": "أضف إلى البيع",
  "Remove": "إزالة", "Hold current cart": "تعليق السلة الحالية", "Open held carts": "السلال المعلقة",
  "Subtotal": "المجموع الفرعي", "Discount": "الخصم", "VAT": "ضريبة القيمة المضافة", "Total": "الإجمالي",
  "Charge": "تحصيل", "Clear": "مسح", "Customer": "العميل", "Clear customer": "إزالة العميل",
  // payment
  "Charge sale": "تحصيل البيع", "Payment method": "طريقة الدفع", "Cash": "نقدًا", "Card": "بطاقة",
  "BenefitPay": "بنفت باي", "Bank Transfer": "تحويل بنكي", "Complete sale": "إتمام البيع", "Change": "الباقي",
  "Remaining": "المتبقي", "Allocated": "المخصص", "Tip": "إكرامية", "No tip": "بدون إكرامية",
  "Discount coupon": "قسيمة خصم", "Apply": "تطبيق", "Custom amount": "مبلغ آخر", "Payment allocations": "توزيع المدفوعات",
  "Total payable, including tip": "الإجمالي المستحق شاملًا الإكرامية",
  // cash
  "Current register": "الصندوق الحالي", "Closing history": "سجل الإغلاق", "Z-report": "تقرير Z",
  "Z-report (end of day)": "تقرير Z (نهاية اليوم)", "Print": "طباعة",
  // toasts
  "Could not complete the sale": "تعذر إتمام البيع",
  "You must open the register before making in-person sales": "يجب فتح الصندوق قبل البيع",
  "The ZAIPOS server is unreachable. This sale is stored on this terminal and will sync automatically.": "خادم ZAIPOS غير متاح. تم حفظ هذا البيع على الجهاز وستتم مزامنته تلقائيًا.",
};
