import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductMergeDialog } from "./ProductMergeDialog";
import { mergeDuplicateProduct, previewProductMerge } from "@/lib/productMergeCommands";

vi.mock("@/lib/productMergeCommands", () => ({
  previewProductMerge: vi.fn(),
  mergeDuplicateProduct: vi.fn(),
}));

const previewMock = vi.mocked(previewProductMerge);
const mergeMock = vi.mocked(mergeDuplicateProduct);

const source = {
  id: "source-product",
  name: "Duplicate Cola 330ml",
  sku: "DUP-COLA",
  status: "active",
};

const products = [
  source,
  { id: "canonical-product", name: "Cola 330ml", sku: "COLA-330", status: "active" },
  { id: "inactive-product", name: "Old Cola", sku: "OLD-COLA", status: "inactive" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProductMergeDialog", () => {
  it("requires an authoritative safe preview and explicit confirmation before merging", async () => {
    previewMock.mockResolvedValue({
      tenant_id: "tenant-a",
      source_product_id: source.id,
      canonical_product_id: "canonical-product",
      can_merge: true,
      blockers: [],
      source_stock_quantity: "5.000",
      canonical_stock_quantity: "2.000",
      combined_stock_quantity: "7.000",
      source_barcode_count: 2,
    });
    mergeMock.mockResolvedValue({
      source_product_id: source.id,
      canonical_product_id: "canonical-product",
    });
    const onMerged = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <ProductMergeDialog
        open
        onOpenChange={onOpenChange}
        tenantId="tenant-a"
        sourceProduct={source}
        products={products}
        onMerged={onMerged}
      />,
    );

    expect(screen.queryByRole("option", { name: /Old Cola/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Canonical product"), { target: { value: "canonical-product" } });
    fireEvent.click(screen.getByRole("button", { name: "Review merge" }));

    await waitFor(() => expect(previewMock).toHaveBeenCalledWith("tenant-a", source.id, "canonical-product"));
    expect(screen.getByText("7.000")).toBeInTheDocument();
    expect(screen.getByText(/2 source barcodes/)).toBeInTheDocument();

    const mergeButton = screen.getByRole("button", { name: "Merge duplicate" });
    expect(mergeButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Merge reason"), { target: { value: "Verified duplicate catalogue record" } });
    fireEvent.change(screen.getByLabelText("Type MERGE to confirm"), { target: { value: "MERGE" } });
    expect(mergeButton).toBeEnabled();
    fireEvent.click(mergeButton);

    await waitFor(() => expect(mergeMock).toHaveBeenCalledWith(
      "tenant-a",
      source.id,
      "canonical-product",
      "Verified duplicate catalogue record",
      expect.stringMatching(/^product-merge-/),
    ));
    expect(onMerged).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces live blockers and never enables a blocked destructive merge", async () => {
    previewMock.mockResolvedValue({
      tenant_id: "tenant-a",
      source_product_id: source.id,
      canonical_product_id: "canonical-product",
      can_merge: false,
      blockers: ["held_cart", "production", "price_override"],
      source_stock_quantity: "5.000",
      canonical_stock_quantity: "2.000",
      combined_stock_quantity: "7.000",
      source_barcode_count: 2,
    });

    render(
      <ProductMergeDialog
        open
        onOpenChange={vi.fn()}
        tenantId="tenant-a"
        sourceProduct={source}
        products={products}
        onMerged={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Canonical product"), { target: { value: "canonical-product" } });
    fireEvent.click(screen.getByRole("button", { name: "Review merge" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("held cart");
    expect(screen.getByRole("alert")).toHaveTextContent("production order");
    expect(screen.getByRole("alert")).toHaveTextContent("price override");
    fireEvent.change(screen.getByLabelText("Merge reason"), { target: { value: "Verified duplicate" } });
    fireEvent.change(screen.getByLabelText("Type MERGE to confirm"), { target: { value: "MERGE" } });
    expect(screen.getByRole("button", { name: "Merge duplicate" })).toBeDisabled();
    expect(mergeMock).not.toHaveBeenCalled();
  });
});
