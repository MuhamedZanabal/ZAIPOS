import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { bhd, CUSTOMER_DISPLAY_KEY, parseCustomerDisplay, publishCustomerDisplay } from "./customerDisplay";
import CustomerDisplay from "@/pages/CustomerDisplay";

vi.mock("electron", () => ({ BrowserWindow: class {}, screen: {} }));

describe("customer display feed", () => {
  it("formats BHD to three decimals", () => {
    expect(bhd(0)).toBe("0.000");
    expect(bhd(12345)).toBe("12.345");
    expect(bhd(-50)).toBe("-0.050");
  });
  it("rejects malformed or non-fils data", () => {
    expect(parseCustomerDisplay("not json").status).toBe("idle");
    expect(parseCustomerDisplay({ status: "active", lines: [], discountFils: 0, vatFils: 0.5, totalFils: 1 }).status).toBe("idle");
    const ok = parseCustomerDisplay({ status: "active", lines: [{ name: "x".repeat(200), quantity: 2, totalFils: 1000 }, { bad: true }], discountFils: 0, vatFils: 100, totalFils: 1100 });
    expect(ok.lines).toHaveLength(1);
    expect(ok.lines[0].name).toHaveLength(80);
  });
  it("renders the published ticket bilingually with the BHD total", () => {
    publishCustomerDisplay({ status: "active", businessName: "Seef Grill", lines: [{ name: "Karak tea", quantity: 2, totalFils: 400 }], discountFils: 40, vatFils: 36, totalFils: 396 });
    expect(JSON.parse(localStorage.getItem(CUSTOMER_DISPLAY_KEY)!).totalFils).toBe(396);
    render(<CustomerDisplay />);
    expect(screen.getByText("Seef Grill")).toBeTruthy();
    expect(screen.getByText(/Karak tea/)).toBeTruthy();
    expect(screen.getByTestId("cd-total").textContent).toBe("BHD 0.396");
    expect(screen.getByText("ضريبة القيمة المضافة", { exact: false })).toBeTruthy();
    act(() => { publishCustomerDisplay({ status: "paid", lines: [], discountFils: 0, vatFils: 0, totalFils: 396, changeFils: 604 }); window.dispatchEvent(new StorageEvent("storage", { key: CUSTOMER_DISPLAY_KEY })); });
    expect(screen.getByText(/Thank you/)).toBeTruthy();
  });
});

describe("customer display window config", async () => {
  const { customerDisplayMode, customerDisplayUrl } = await import("../../electron/services/customer-display");
  it("is auto by default and can be forced on/off", () => {
    expect(customerDisplayMode(undefined)).toBe("auto");
    expect(customerDisplayMode("1")).toBe("on");
    expect(customerDisplayMode("0")).toBe("off");
  });
  it("uses the hash route for packaged builds and path route in dev", () => {
    expect(customerDisplayUrl("/opt/zaipos/dist/index.html")).toBe("file:///opt/zaipos/dist/index.html#/customer-display");
    expect(customerDisplayUrl("/x", "http://localhost:8080")).toBe("http://localhost:8080/customer-display");
  });
});
