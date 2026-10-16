import { describe, expect, it } from "vitest";
import { englishServerMessage } from "./serverMessages";

describe("englishServerMessage", () => {
  it("strips the Electron IPC wrapper and translates", () => {
    expect(englishServerMessage("Error invoking remote method 'device-table-checkout': Error: La mesa no tiene items despachados para cobrar"))
      .toBe("Nothing to charge yet: mark the items as served first");
  });
  it("translates parameterised messages", () => {
    expect(englishServerMessage("Los pagos (6.270) no coinciden con el total (4.950)")).toBe("Payments (6.270) do not match the total (4.950)");
  });
  it("leaves English messages alone", () => {
    expect(englishServerMessage("Payments (6270 fils) must exactly equal sale total (4950 fils)")).toBe("Payments (6270 fils) must exactly equal sale total (4950 fils)");
  });
});
