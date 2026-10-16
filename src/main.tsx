import { createRoot, type Root } from "react-dom/client";
import "./fonts";
import "./index.css";
import { installErrorReporting } from "./lib/errorReporting";

installErrorReporting();
import { initializeRuntimeConfig } from "./runtime-config";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("ZAIPOS root element is unavailable");

let root: Root | null = null;

const renderApp = async () => {
  const [{ default: App }, { registerPWA }] = await Promise.all([
    import("./App.tsx"),
    import("./pwa"),
  ]);
  document.title = "ZAIPOS";
  root ??= createRoot(rootElement);
  root.render(<App />);
  registerPWA();
};

/** The customer display window has no desktop bridge and no backend: render it standalone. */
const isCustomerDisplay = () =>
  window.location.hash.replace(/^#/, "").split("?")[0] === "/customer-display" ||
  window.location.pathname.endsWith("/customer-display");

const bootstrap = async () => {
  if (isCustomerDisplay()) {
    const { default: CustomerDisplay } = await import("./pages/CustomerDisplay.tsx");
    root ??= createRoot(rootElement);
    root.render(<CustomerDisplay />);
    return;
  }
  const runtimeConfig = await initializeRuntimeConfig();
  const local = await window.electron?.localStatus?.().catch(() => null);
  const localReady = local?.state === "configured";
  const hasSession = typeof localStorage !== "undefined" && Boolean(localStorage.getItem("zaipos.local.session"));

  if (runtimeConfig.ok || (localReady && hasSession)) {
    await renderApp();
    return;
  }

  document.title = "ZAIPOS — This Computer";
  const { default: LocalServerSetup } = await import("./components/setup/LocalServerSetup.tsx");
  root ??= createRoot(rootElement);
  root.render(<LocalServerSetup configured={localReady} onReady={() => { void renderApp(); }} />);
};

void bootstrap();
