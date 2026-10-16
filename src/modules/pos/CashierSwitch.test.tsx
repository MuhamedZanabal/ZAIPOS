import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq"]) chain[k] = () => chain;
  chain.order = async () => ({ data: [{ id: "e1", full_name: "Fatima", role: "cashier" }], error: null });
  return { supabase: { from: () => chain, functions: { invoke: (...a: unknown[]) => invoke(...a) } } };
});

import { CashierSwitch } from "./CashierSwitch";
import { useActiveCashier } from "@/stores/activeCashier";

const renderSwitch = () => render(
  <QueryClientProvider client={new QueryClient()}><CashierSwitch tenantId="t1" branchId="b1" cashSessionId="s1" /></QueryClientProvider>,
);

async function enterPin(pin: string) {
  fireEvent.click(screen.getByTestId("cashier-switch"));
  fireEvent.click(await screen.findByText("Fatima"));
  fireEvent.change(screen.getByTestId("cashier-pin"), { target: { value: pin } });
  fireEvent.click(screen.getByRole("button", { name: "Switch" }));
}

describe("CashierSwitch", () => {
  beforeEach(() => { invoke.mockReset(); toastError.mockReset(); useActiveCashier.getState().setCashier(null); (window as any).electron = { getDeviceIdentity: async () => ({ deviceUid: "till-device-0001", provisioned: true }) }; });

  it("verifies the PIN on the server and sets the active cashier", async () => {
    invoke.mockResolvedValue({ data: { verified: true }, error: null });
    renderSwitch();
    await enterPin("4821");
    await waitFor(() => expect(useActiveCashier.getState().cashier?.name).toBe("Fatima"));
    expect(invoke).toHaveBeenCalledWith("pos-pin", { body: expect.objectContaining({ action: "verify", employee_id: "e1", pin: "4821", device_uid: "till-device-0001", cash_session_id: "s1" }) });
    expect(screen.getByTestId("cashier-switch")).toHaveTextContent("Fatima");
  });

  it("reports wrong and locked PINs without switching", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "POS PIN is temporarily locked" } });
    renderSwitch();
    await enterPin("0000");
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("locked")));
    expect(useActiveCashier.getState().cashier).toBeNull();
  });
});
