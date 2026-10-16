import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { Simulation } from "../core/simulator";
import { SAMPLE_CATALOG } from "../core/fixtures";
import { receiveEvolutionWebhook } from "../core/receiver";
import { EvolutionGateway } from "../core/sender";

const OUT = process.env.WA_SIM_DIR; // set to save transcripts, e.g. /workspace/omega/sprint/whatsapp_sim
const save = (name: string, s: Simulation) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}.txt`, `# ${name} (simulated, mock gateway — no real WhatsApp traffic)\n\n${s.transcript.join("\n")}\n`);
};
const A = "97333000001@s.whatsapp.net";

describe("end-to-end WhatsApp flow (mock gateway)", () => {
  it("delivery order: browse → order → confirm → statuses → delivered", async () => {
    const s = new Simulation(SAMPLE_CATALOG);
    await s.say(A, "hi");
    await s.say(A, "menu");
    await s.say(A, "1");
    await s.say(A, "2 shawarma extra garlic and 1 karak");
    await s.say(A, "checkout");
    await s.say(A, "1");
    await s.say(A, "Road 2803, Block 428, Seef", { location: { lat: 26.23, lng: 50.53, address: "Road 2803, Block 428, Seef" } });
    await s.say(A, "1");
    const summary = s.order(A);
    expect(summary.status).toBe("AWAITING_CONFIRMATION");
    await s.say(A, "yes");
    expect(s.order(A).status).toBe("CONFIRMED");
    expect(s.order(A).orderNumber).toBeTruthy();
    for (const st of ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY"] as const) await s.staff(A, st);
    await s.say(A, "status");
    await s.staff(A, "DELIVERED");
    expect(s.order(A).status).toBe("DELIVERED");
    expect(s.gateway.sent.length).toBeGreaterThan(8);
    save("01_delivery_happy_path", s);
  });

  it("Arabic pickup order picked up", async () => {
    const s = new Simulation(SAMPLE_CATALOG);
    await s.say(A, "السلام عليكم");
    await s.say(A, "ابي ٢ فلافل");
    await s.say(A, "اطلب");
    await s.say(A, "2");
    await s.say(A, "1");
    await s.say(A, "نعم");
    for (const st of ["ACCEPTED", "PREPARING", "READY", "READY_FOR_PICKUP", "PICKED_UP"] as const) await s.staff(A, st);
    expect(s.order(A).status).toBe("PICKED_UP");
    save("02_arabic_pickup", s);
  });

  it("customer cancels before kitchen; asks for human after", async () => {
    const s = new Simulation(SAMPLE_CATALOG);
    await s.say(A, "1 machboos");
    await s.say(A, "checkout"); await s.say(A, "2"); await s.say(A, "1"); await s.say(A, "yes");
    await s.say(A, "cancel");
    expect(s.order(A).status).toBe("CANCELLED");
    const before = s.gateway.sent.length;
    await s.say(A, "talk to a human");
    expect(s.store.conversations.get(A)!.handoff).toBe(true);
    const afterHandoff = s.gateway.sent.length;
    expect(afterHandoff).toBeGreaterThan(before);
    await s.say(A, "hello?"); // AI must stay silent during handoff
    expect(s.gateway.sent.length).toBe(afterHandoff);
    await s.engine.setHandoff(A, false); await s.flush();
    expect(s.store.conversations.get(A)!.handoff).toBe(false);
    save("03_cancel_and_handoff", s);
  });

  it("cancel during preparation hands off to staff instead of cancelling", async () => {
    const s = new Simulation(SAMPLE_CATALOG);
    await s.say(A, "1 falafel"); await s.say(A, "checkout"); await s.say(A, "2"); await s.say(A, "1"); await s.say(A, "yes");
    await s.staff(A, "ACCEPTED"); await s.staff(A, "PREPARING");
    await s.say(A, "cancel");
    expect(s.order(A).status).toBe("PREPARING");
    expect(s.store.conversations.get(A)!.handoff).toBe(true);
    await s.staff(A, "CANCELLED", { cancelReason: "customer request, approved by staff" });
    expect(s.order(A).status).toBe("CANCELLED");
    save("04_late_cancel_staff", s);
  });

  it("sold out between quote and confirm → re-quote; duplicate webhook ignored", async () => {
    const s = new Simulation(SAMPLE_CATALOG);
    await s.say(A, "2 machboos", { id: "DUP-1" });
    const r = await s.say(A, "2 machboos", { id: "DUP-1" });
    expect(r).toEqual([]);
    expect(s.order(A).lines[0].qty).toBe(2);
    await s.say(A, "checkout"); await s.say(A, "2"); await s.say(A, "1");
    s.catalog.items.find((c) => c.productId === "p-machboos")!.stock = 1;
    await s.say(A, "yes");
    expect(s.order(A).status).toBe("AWAITING_CONFIRMATION");
    expect(s.order(A).lines[0].qty).toBe(1);
    await s.say(A, "yes");
    expect(s.order(A).status).toBe("CONFIRMED");
    save("05_requote_and_dedupe", s);
  });

  it("stale staff update is rejected (optimistic version conflict)", async () => {
    const s = new Simulation(SAMPLE_CATALOG);
    await s.say(A, "1 karak"); await s.say(A, "checkout"); await s.say(A, "2"); await s.say(A, "1"); await s.say(A, "yes");
    const o = s.order(A);
    await s.engine.staffTransition(A, o.id, "ACCEPTED", o.version);
    await expect(s.engine.staffTransition(A, o.id, "REJECTED", o.version)).rejects.toThrow();
    expect(s.order(A).status).toBe("ACCEPTED");
  });
});

describe("Evolution webhook receiver + sender", () => {
  const body = (o: object) => JSON.stringify(o);
  const msg = { event: "messages.upsert", data: { key: { remoteJid: A, fromMe: false, id: "X1" }, message: { conversation: "hi" }, messageTimestamp: 1 } };
  it("rejects bad token, ignores groups, handles messages, reports session", async () => {
    const handled: string[] = []; const sessions: string[] = [];
    const deps = { secret: "s3cret", handle: async (m: { text: string }) => { handled.push(m.text); return { status: "processed" as const }; },
      onSession: async (x: { state: string }) => { sessions.push(x.state); } };
    const post = (b: object, token = "s3cret") => receiveEvolutionWebhook(new Request(`https://x/wa?token=${token}`, { method: "POST", body: body(b) }), deps);
    expect((await post(msg, "nope")).status).toBe(401);
    expect((await post(msg)).status).toBe(200);
    const g = structuredClone(msg); g.data.key.remoteJid = "123@g.us";
    expect(await (await post(g)).json()).toMatchObject({ ignored: true });
    await post({ event: "connection.update", data: { state: "close" } });
    expect(handled).toEqual(["hi"]); expect(sessions).toEqual(["close"]);
  });
  it("returns 500 on processing failure so Evolution retries", async () => {
    const r = await receiveEvolutionWebhook(new Request("https://x/wa", { method: "POST", headers: { "x-webhook-token": "k" }, body: body(msg) }),
      { secret: "k", handle: async () => { throw new Error("db down"); } });
    expect(r.status).toBe(500);
  });
  it("EvolutionGateway calls sendText with apikey header", async () => {
    const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const f = async (url: string, init: never) => { calls.push({ url, init }); return { ok: true, status: 201, json: async () => ({ key: { id: "OUT1" } }) }; };
    const gw = new EvolutionGateway("https://evo.example/", "KEY", "seefgrill", f as never);
    expect(await gw.sendText(A, "hello")).toEqual({ id: "OUT1" });
    expect(calls[0].url).toBe("https://evo.example/message/sendText/seefgrill");
    expect(calls[0].init.headers.apikey).toBe("KEY");
    expect(JSON.parse(calls[0].init.body)).toEqual({ number: A, text: "hello" });
  });
});
