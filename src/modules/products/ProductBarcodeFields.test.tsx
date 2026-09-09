import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProductBarcodeInspection } from "@/lib/productBarcodeCommands";
import type { ProductBarcode } from "@/lib/productBarcodes";
import { ProductBarcodeFields } from "./ProductBarcodeFields";

function Harness({ issues = [] }: { issues?: ProductBarcodeInspection[] }) {
  const [barcodes, setBarcodes] = useState<ProductBarcode[]>([
    { barcode: "6290000000777", barcode_type: "ean_13", is_primary: true },
  ]);
  return <ProductBarcodeFields barcodes={barcodes} issues={issues} scanning={false} onChange={setBarcodes} onStartScan={vi.fn()} />;
}

describe("ProductBarcodeFields", () => {
  it("adds alternate codes and moves the primary marker explicitly", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add code" }));
    expect(screen.getByLabelText("Barcode 2")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Barcode 2"), { target: { value: "case-24-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Make barcode 2 primary" }));
    expect(screen.getAllByRole("button", { name: "Primary barcode" })).toHaveLength(1);
    expect(screen.getByLabelText("Barcode 2")).toHaveValue("case-24-a");
  });

  it("shows retired-product collisions as a separate resolution state", () => {
    render(<Harness issues={[{
      input_index: 0,
      barcode: "6290000000777",
      normalized_barcode: "6290000000777",
      barcode_type: "ean_13",
      is_primary: true,
      state: "retired_product_conflict",
      conflicting_product_id: "retired-product",
      conflicting_product_name: "Retired Water",
      conflicting_product_status: "inactive",
    }]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Assigned to retired product Retired Water");
  });
});
