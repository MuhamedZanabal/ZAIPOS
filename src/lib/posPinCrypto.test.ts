import { describe, expect, it } from "vitest";
import { hashPosPin, verifyPosPin } from "../../supabase/functions/_shared/pos-pin-crypto";

describe("POS PIN Argon2id contract", () => {
  it("hashes a PIN with Argon2id and never embeds the plaintext PIN", async () => {
    const encoded = await hashPosPin("4826", new Uint8Array(16).fill(7));

    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(encoded).not.toContain("4826");
    await expect(verifyPosPin(encoded, "4826")).resolves.toBe(true);
    await expect(verifyPosPin(encoded, "4827")).resolves.toBe(false);
  });

  it("fails closed for malformed hashes", async () => {
    await expect(verifyPosPin("not-an-argon2id-hash", "4826")).resolves.toBe(false);
  });
});
