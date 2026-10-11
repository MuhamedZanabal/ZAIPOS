import { useEffect, useState } from "react";
import { bhd, IDLE_STATE, subscribeCustomerDisplay, type CustomerDisplayState } from "@/lib/customerDisplay";

/** Bilingual (English / Arabic) counter screen. Read-only; runs in a window with no bridge. */
export default function CustomerDisplay() {
  const [state, setState] = useState<CustomerDisplayState>(IDLE_STATE);
  useEffect(() => subscribeCustomerDisplay(setState), []);
  useEffect(() => { document.title = "ZAIPOS — Customer display"; }, []);

  const Pair = ({ en, ar, value, big }: { en: string; ar: string; value: string; big?: boolean }) => (
    <div className={`flex items-baseline justify-between ${big ? "text-5xl font-bold pt-4 border-t border-white/20" : "text-2xl"}`}>
      <span>{en} <span dir="rtl" lang="ar" className="font-arabic opacity-80">· {ar}</span></span>
      <span className="tabular-nums" data-testid={big ? "cd-total" : undefined}>BHD {value}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white flex flex-col p-10 gap-6 select-none" data-testid="customer-display">
      <header className="flex items-center justify-between text-3xl font-semibold">
        <span>{state.businessName ?? "ZAIPOS"}</span>
        <span dir="rtl" lang="ar" className="font-arabic">{state.status === "paid" ? "شكرًا لزيارتكم" : "أهلًا وسهلًا"}</span>
      </header>
      {state.status === "idle" || (state.lines.length === 0 && state.status !== "paid") ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-5xl">
          <span>Welcome</span>
          <span dir="rtl" lang="ar" className="font-arabic">مرحبًا بكم</span>
        </div>
      ) : state.status === "paid" ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <span className="text-5xl">Thank you <span dir="rtl" lang="ar" className="font-arabic">· شكرًا لكم</span></span>
          <span className="text-6xl font-bold tabular-nums" data-testid="cd-total">BHD {bhd(state.totalFils)}</span>
          {state.changeFils ? <span className="text-3xl">Change <span dir="rtl" lang="ar" className="font-arabic">· الباقي</span>: BHD {bhd(state.changeFils)}</span> : null}
        </div>
      ) : (
        <>
          <ul className="flex-1 overflow-hidden flex flex-col gap-2 text-2xl">
            {state.lines.map((line, i) => (
              <li key={i} className="flex justify-between border-b border-white/10 pb-2">
                <span className="truncate pe-4">{line.quantity} × {line.name}</span>
                <span className="tabular-nums">{bhd(line.totalFils)}</span>
              </li>
            ))}
          </ul>
          <footer className="flex flex-col gap-2">
            {state.discountFils > 0 && <Pair en="Discount" ar="الخصم" value={`-${bhd(state.discountFils)}`} />}
            <Pair en="VAT" ar="ضريبة القيمة المضافة" value={bhd(state.vatFils)} />
            <Pair en="Total" ar="الإجمالي" value={bhd(state.totalFils)} big />
          </footer>
        </>
      )}
    </div>
  );
}
