import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface ActiveCashier { employeeId: string; name: string; role: string | null; branchId: string; verifiedAt: string }

/** Cashier currently at the till (PIN-verified). Kept for this app session only. */
export const useActiveCashier = create<{ cashier: ActiveCashier | null; setCashier: (c: ActiveCashier | null) => void }>()(
  persist((set) => ({ cashier: null, setCashier: (cashier) => set({ cashier }) }), {
    name: "zaipos.active-cashier",
    storage: createJSONStorage(() => sessionStorage),
  }),
);
