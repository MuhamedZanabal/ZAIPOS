import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, type Router } from "react-router-dom";

const routers: Router[] = [];

function createRouter() {
  const router = createMemoryRouter([{ path: "*", element: null }], {
    initialEntries: ["/"],
  });
  routers.push(router);
  return router;
}

afterEach(() => {
  for (const router of routers.splice(0)) {
    router.dispose();
  }
});

describe("router navigation security", () => {
  it.each([
    String.raw`\\attacker.example/path`,
    "//attacker.example/path",
    "https://attacker.example/path",
  ])("rejects untrusted external navigation target %s", async (target) => {
    const router = createRouter();

    await expect(router.navigate(target)).rejects.toThrow(
      "External navigation is not allowed",
    );
    expect(router.state.location.pathname).toBe("/");
  });

  it("continues to permit internal application routes", () => {
    const router = createRouter();

    expect(router.createHref({ pathname: "/pos" })).toBe("/pos");
  });
});
