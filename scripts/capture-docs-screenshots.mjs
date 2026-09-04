import fs from "node:fs";
import { chromium } from "playwright";

const baseUrl = process.env.DOCS_APP_URL || "http://127.0.0.1:4173";
const outDir = "docs/screenshots";
fs.mkdirSync(outDir, { recursive: true });

const specs = [
  { file: "landing.png", path: "/", viewport: { width: 1440, height: 900 }, expected: ["ZAIPOS", "Run your sales like"] },
  { file: "dashboard.png", path: "/dashboard", viewport: { width: 1440, height: 1000 }, expected: ["Today's sales", "BHD", "Talabat"] },
  { file: "pos-desktop.png", path: "/pos", viewport: { width: 1440, height: 900 }, expected: ["Almarai Fresh Milk 1L", "BHD"] },
  { file: "pos-mobile.png", path: "/pos", viewport: { width: 390, height: 844 }, expected: ["Almarai Fresh Milk 1L"] },
  { file: "digital-orders.png", path: "/digital-orders", viewport: { width: 1440, height: 900 }, expected: ["Talabat", "TB-2048", "BHD"] },
  { file: "settings.png", path: "/settings", viewport: { width: 1440, height: 900 }, expected: ["Settings", "Bahraini Dinar", "Bahrain standard VAT is 10%"] },
];

async function capture(browser, spec) {
  const context = await browser.newContext({
    viewport: spec.viewport,
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const runtimeErrors = [];

  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.stack || error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console.error: ${message.text()}`);
  });
  page.on("requestfailed", (request) => runtimeErrors.push(`requestfailed: ${request.method()} ${request.url()} :: ${request.failure()?.errorText || "unknown"}`));

  await page.goto(`${baseUrl}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1600);

  try {
    for (const text of spec.expected) {
      await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: 12_000 });
    }
  } catch (error) {
    console.error(`Capture assertion failed for ${spec.file}`);
    console.error(`Current URL: ${page.url()}`);
    console.error(`Rendered text: ${(await page.locator("body").innerText()).slice(0, 5000)}`);
    if (runtimeErrors.length) console.error(`Runtime errors:\n${runtimeErrors.join("\n")}`);
    throw error;
  }

  if (runtimeErrors.some((entry) => entry.startsWith("pageerror:"))) {
    console.error(`Runtime errors detected for ${spec.file}:\n${runtimeErrors.join("\n")}`);
    throw new Error(`Browser runtime error while capturing ${spec.file}`);
  }

  await page.screenshot({ path: `${outDir}/${spec.file}`, fullPage: false, animations: "disabled" });
  console.log(`Captured ${spec.file}`);
  await context.close();
}

const browser = await chromium.launch({ headless: true });
try {
  for (const spec of specs) await capture(browser, spec);
} finally {
  await browser.close();
}

console.log(`Captured ${specs.length} current ZAIPOS documentation screenshots.`);
