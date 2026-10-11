import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LabelPrintDialog, labelCode } from "./LabelPrintDialog";

describe("LabelPrintDialog", () => {
  const products = [
    { id: "a", name: "Karak tea", price: 0.2, sku: "TEA-1", product_barcodes: [{ barcode: "6290000000771", is_primary: true }] },
    { id: "b", name: "Samosa", price: "0.350", sku: "SAM-2", product_barcodes: [] },
    { id: "c", name: "No code", price: 1, sku: null, product_barcodes: [] },
  ];
  it("picks the primary barcode, then the SKU", () => {
    expect(labelCode(products[0])).toBe("6290000000771");
    expect(labelCode(products[1])).toBe("SAM-2");
    expect(labelCode(products[2])).toBeNull();
  });
  it("lists labelable products and renders the print sheet", () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    render(<LabelPrintDialog products={products} />);
    fireEvent.click(screen.getByTestId("print-labels"));
    expect(screen.queryByText("No code")).toBeNull();
    expect(screen.getByText(/6290000000771 · EAN-13/)).toBeTruthy();
    expect(screen.getByText(/SAM-2 · Code 128/)).toBeTruthy();
    fireEvent.change(screen.getByTestId("label-copies-a"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("labels-print"));
    expect(print).toHaveBeenCalled();
    expect(document.querySelectorAll(".label-print-item")).toHaveLength(3);
    expect(document.querySelector(".label-print svg")?.getAttribute("aria-label")).toBe("6290000000771");
  });
});
