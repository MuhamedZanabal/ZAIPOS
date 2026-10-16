import type { CartLine, CatalogItem, Lang, Order, OrderStatus, PaymentMethod } from "./types";
import { formatBhd, quote } from "./pricing";

type T = { en: string; ar: string };
const t = (lang: Lang, m: T) => m[lang];
const name = (lang: Lang, l: { nameEn: string; nameAr?: string }) => (lang === "ar" && l.nameAr ? l.nameAr : l.nameEn);

export const M = {
  greeting: (lang: Lang, shop: string) => t(lang, {
    en: `Welcome to ${shop}! 👋\nReply *menu* to see what we have, or just type your order (e.g. "2 chicken shawarma and a karak").\nReply *help* anytime.`,
    ar: `أهلاً بك في ${shop}! 👋\nاكتب *منيو* لعرض القائمة، أو اكتب طلبك مباشرة (مثلاً: "حبتين شاورما دجاج وكرك").\nاكتب *مساعدة* في أي وقت.`,
  }),
  help: (lang: Lang) => t(lang, {
    en: "Help:\n• *menu* – see categories\n• type items to add them (\"2 burger\")\n• *remove burger* – remove an item\n• *done* – checkout\n• *status* – where is my order\n• *cancel* – cancel order\n• *agent* – talk to a person\n• *stop* – stop all messages",
    ar: "المساعدة:\n• *منيو* – عرض الأقسام\n• اكتب الأصناف لإضافتها (\"حبتين برجر\")\n• *شيل برجر* – حذف صنف\n• *خلاص* – إتمام الطلب\n• *وين طلبي* – حالة الطلب\n• *الغاء* – إلغاء الطلب\n• *موظف* – التحدث مع موظف\n• *ايقاف* – إيقاف الرسائل",
  }),
  categories: (lang: Lang, cats: { en: string; ar?: string }[]) =>
    t(lang, { en: "Menu – reply with a number:", ar: "القائمة – اختر رقم القسم:" }) + "\n" +
    cats.map((c, i) => `${i + 1}. ${lang === "ar" && c.ar ? c.ar : c.en}`).join("\n"),
  items: (lang: Lang, items: CatalogItem[]) =>
    t(lang, { en: "Reply with the item number to add it (send it again to add more):", ar: "اختر رقم الصنف لإضافته (أرسله مرة ثانية لزيادة الكمية):" }) + "\n" +
    items.map((c, i) => `${i + 1}. ${name(lang, c)} – ${formatBhd(c.priceFils)}${c.available ? "" : t(lang, { en: " (sold out)", ar: " (نفدت الكمية)" })}`).join("\n"),
  cart: (lang: Lang, lines: CartLine[]) => {
    if (!lines.length) return t(lang, { en: "Your cart is empty.", ar: "السلة فارغة." });
    const q = quote(lines, 0);
    return t(lang, { en: "Your cart:", ar: "سلتك:" }) + "\n" +
      lines.map((l) => `• ${l.qty} × ${name(lang, l)}${l.modifiers.length ? ` (${l.modifiers.join(", ")})` : ""} – ${formatBhd(Math.round(l.unitPriceFils * l.qty))}`).join("\n") +
      "\n" + t(lang, { en: `Subtotal (excl. VAT): ${formatBhd(q.subtotalFils)}\nAdd more items, or reply *done* to checkout.`,
        ar: `المجموع قبل الضريبة: ${formatBhd(q.subtotalFils)}\nأضف أصناف أخرى أو اكتب *خلاص* لإتمام الطلب.` });
  },
  notFound: (lang: Lang, what?: string) => t(lang, {
    en: `Sorry, I couldn't find ${what ? `"${what}"` : "that"} on our menu. Reply *menu* to see what we have, or *agent* for a person.`,
    ar: `عذراً، ما لقيت ${what ? `"${what}"` : "هذا الصنف"} في القائمة. اكتب *منيو* لعرض الأصناف أو *موظف* للتحدث مع موظف.`,
  }),
  soldOut: (lang: Lang, names: string[]) => t(lang, { en: `Sorry, sold out right now: ${names.join(", ")}.`, ar: `عذراً، غير متوفر حالياً: ${names.join("، ")}.` }),
  askFulfilment: (lang: Lang, feeFils: number) => t(lang, {
    en: `Delivery or pickup?\n1. Delivery (+${formatBhd(feeFils)})\n2. Pickup`, ar: `توصيل أو استلام؟\n1. توصيل (+${formatBhd(feeFils)})\n2. استلام من الفرع`,
  }),
  askAddress: (lang: Lang) => t(lang, {
    en: "Please send your delivery address (area, road, block, building/flat) or share your 📍 location pin.",
    ar: "أرسل عنوان التوصيل (المنطقة، الطريق، المجمع، المبنى/الشقة) أو شارك 📍 موقعك.",
  }),
  askPayment: (lang: Lang) => t(lang, {
    en: "How will you pay?\n1. Cash on delivery\n2. BenefitPay\n3. Card on delivery",
    ar: "طريقة الدفع؟\n1. كاش عند الاستلام\n2. بنفت باي\n3. بطاقة عند الاستلام",
  }),
  summary: (lang: Lang, o: Order) => {
    const q = quote(o.lines, o.deliveryFeeFils);
    const pay: Record<PaymentMethod, T> = { cash_on_delivery: { en: "Cash on delivery", ar: "كاش عند الاستلام" },
      benefitpay: { en: "BenefitPay", ar: "بنفت باي" }, card_on_delivery: { en: "Card on delivery", ar: "بطاقة عند الاستلام" } };
    const lines = o.lines.map((l) => `• ${l.qty} × ${name(lang, l)}${l.modifiers.length ? ` (${l.modifiers.join(", ")})` : ""} – ${formatBhd(Math.round(l.unitPriceFils * l.qty))}`).join("\n");
    const where = o.fulfilment === "delivery" ? t(lang, { en: `Delivery to: ${o.address ?? "📍 pin"}`, ar: `التوصيل إلى: ${o.address ?? "📍 الموقع"}` })
      : t(lang, { en: "Pickup from the branch", ar: "استلام من الفرع" });
    return t(lang, { en: "Order summary:", ar: "ملخص الطلب:" }) + `\n${lines}\n${where}\n` +
      t(lang, { en: `Subtotal: ${formatBhd(q.subtotalFils)}\nDelivery fee: ${formatBhd(q.deliveryFeeFils)}\nVAT 10%: ${formatBhd(q.vatFils)}\n*Total: ${formatBhd(q.totalFils)}*\nPayment: ${pay[o.paymentMethod!].en}\n\nReply *yes* to confirm or *no* to change.`,
        ar: `المجموع: ${formatBhd(q.subtotalFils)}\nرسوم التوصيل: ${formatBhd(q.deliveryFeeFils)}\nضريبة القيمة المضافة 10%: ${formatBhd(q.vatFils)}\n*الإجمالي: ${formatBhd(q.totalFils)}*\nالدفع: ${pay[o.paymentMethod!].ar}\n\nاكتب *نعم* للتأكيد أو *لا* للتعديل.` });
  },
  requote: (lang: Lang, changes: string[]) => t(lang, {
    en: `Heads up – something changed since you built your cart:\n${changes.join("\n")}\nHere is the updated order:`,
    ar: `تنبيه – تغيّر شيء منذ إضافة الأصناف:\n${changes.join("\n")}\nهذا الطلب المحدّث:`,
  }),
  status: (lang: Lang, o: Order) => {
    const n = o.orderNumber ?? "";
    const eta = o.etaMinutes ? t(lang, { en: ` ETA about ${o.etaMinutes} min.`, ar: ` الوقت المتوقع حوالي ${o.etaMinutes} دقيقة.` }) : "";
    const map: Partial<Record<OrderStatus, T>> = {
      CONFIRMED: { en: `✅ Order ${n} received! We'll confirm it shortly.`, ar: `✅ استلمنا طلبك ${n}! بنأكده لك قريباً.` },
      ACCEPTED: { en: `👍 Order ${n} accepted.${eta}`, ar: `👍 تم قبول طلبك ${n}.${eta}` },
      PREPARING: { en: `👨‍🍳 Order ${n} is being prepared.${eta}`, ar: `👨‍🍳 طلبك ${n} قيد التحضير.${eta}` },
      READY: { en: `Order ${n} is ready.`, ar: `طلبك ${n} جاهز.` },
      OUT_FOR_DELIVERY: { en: `🛵 Order ${n} is on the way${o.courierName ? ` with ${o.courierName}` : ""}.${eta}\nReply *received* when it arrives.`,
        ar: `🛵 طلبك ${n} في الطريق${o.courierName ? ` مع ${o.courierName}` : ""}.${eta}\nاكتب *استلمت* عند وصوله.` },
      READY_FOR_PICKUP: { en: `🛍️ Order ${n} is ready for pickup.`, ar: `🛍️ طلبك ${n} جاهز للاستلام.` },
      DELIVERED: { en: `Order ${n} delivered. Thank you! 🙏 Message us anytime to order again.`, ar: `تم توصيل طلبك ${n}. شكراً لك! 🙏 راسلنا في أي وقت لطلب جديد.` },
      PICKED_UP: { en: `Order ${n} picked up. Thank you! 🙏`, ar: `تم استلام طلبك ${n}. شكراً لك! 🙏` },
      CANCELLED: { en: `Order ${n} has been cancelled.${o.cancelReason ? ` Reason: ${o.cancelReason}` : ""}`, ar: `تم إلغاء الطلب ${n}.${o.cancelReason ? ` السبب: ${o.cancelReason}` : ""}` },
      REJECTED: { en: `Sorry, we can't take order ${n} right now.${o.cancelReason ? ` (${o.cancelReason})` : ""}`, ar: `عذراً، ما نقدر نستقبل الطلب ${n} حالياً.${o.cancelReason ? ` (${o.cancelReason})` : ""}` },
      FAILED_DELIVERY: { en: `We couldn't deliver order ${n}. A team member will contact you.`, ar: `ما قدرنا نوصل الطلب ${n}. بيتواصل معك أحد موظفينا.` },
    };
    return t(lang, map[o.status] ?? { en: `Order ${n}: ${o.status}`, ar: `الطلب ${n}: ${o.status}` });
  },
  cancelRequested: (lang: Lang) => t(lang, { en: "Your order is already being prepared, so I've asked our team about cancelling. They'll reply here shortly.", ar: "طلبك قيد التحضير، أرسلت طلب الإلغاء لفريقنا وبيردون عليك هنا قريباً." }),
  cannotCancel: (lang: Lang) => t(lang, { en: "This order can no longer be cancelled. Reply *agent* if you need help.", ar: "ما يمكن إلغاء الطلب الآن. اكتب *موظف* إذا تحتاج مساعدة." }),
  handoff: (lang: Lang) => t(lang, { en: "Connecting you to a team member. They'll reply here shortly. 🙋", ar: "جاري تحويلك لأحد موظفينا، بيرد عليك هنا قريباً. 🙋" }),
  resumed: (lang: Lang) => t(lang, { en: "You're back with our ordering assistant. Reply *help* for options.", ar: "رجعت لمساعد الطلبات. اكتب *مساعدة* للخيارات." }),
  optedOut: (lang: Lang) => t(lang, { en: "You won't receive more messages from us. Send *start* to order again.", ar: "لن تصلك رسائل منا بعد الآن. أرسل *ابدا* للطلب مرة ثانية." }),
  noOrder: (lang: Lang) => t(lang, { en: "You don't have an active order. Type your order or reply *menu*.", ar: "ما عندك طلب حالياً. اكتب طلبك أو *منيو*." }),
  activeOrder: (lang: Lang, o: Order) => t(lang, { en: `You already have an active order ${o.orderNumber}. Reply *status* to track it or *agent* for help.`, ar: `عندك طلب قائم ${o.orderNumber}. اكتب *وين طلبي* للمتابعة أو *موظف* للمساعدة.` }),
  didntUnderstand: (lang: Lang, hint: string) => t(lang, { en: `Sorry, I didn't get that. ${hint}`, ar: `عذراً، ما فهمت. ${hint}` }),
  cancelledDraft: (lang: Lang) => t(lang, { en: "Okay, I've cleared your order. Message us anytime to start again.", ar: "تمام، ألغيت الطلب. راسلنا في أي وقت للبدء من جديد." }),
  closed: (lang: Lang) => t(lang, { en: "Sorry, we're not taking WhatsApp orders right now. Please try again later.", ar: "عذراً، الطلبات عبر واتساب متوقفة حالياً. حاول لاحقاً." }),
};
