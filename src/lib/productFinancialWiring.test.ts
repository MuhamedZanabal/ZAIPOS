import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("product financial client wiring", () => {
  it("routes product edits through the authoritative base-financial command", () => {
    const form = source("src/modules/products/ProductForm.tsx");
    expect(form).toContain("setProductBaseFinancials");
    expect(form).toContain("financialReason");
    expect(form).toContain('.from("product_prices")');
  });

  it("routes channel overrides through the authoritative price command", () => {
    const channelPrices = source("src/modules/channel-prices/ChannelPrices.tsx");
    expect(channelPrices).toContain("setProductSellingPrice");
    expect(channelPrices).not.toMatch(/\.from\(["']product_channel_prices["']\)\s*\n?\s*\.delete/);
    expect(channelPrices).not.toMatch(/\.from\(["']product_channel_prices["']\)\.insert/);
    expect(channelPrices).toContain('step="0.001"');
  });

  it("records financial changes made through catalogue CSV updates", () => {
    const dataManagement = source("src/modules/settings/DataManagement.tsx");
    expect(dataManagement).toContain("setProductBaseFinancials");
    expect(dataManagement).toContain("Catalogue CSV import");
  });
});
