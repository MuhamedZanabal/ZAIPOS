import { createRoot } from "react-dom/client";
import "./index.css";
import { initializeRuntimeConfig } from "./runtime-config";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("ZAIPOS root element is unavailable");

const bootstrap = async () => {
  const runtimeConfig = await initializeRuntimeConfig();

  if (!runtimeConfig.ok) {
    document.title = "ZAIPOS — Connect Supabase";
    const { default: SupabaseConnector } = await import('./components/setup/SupabaseConnector.tsx');
    createRoot(rootElement).render(<SupabaseConnector onConfigured={() => window.location.reload()} />);
  } else {
    const [{ default: App }, { registerPWA }] = await Promise.all([
      import("./App.tsx"),
      import("./pwa"),
    ]);

    createRoot(rootElement).render(<App />);
    registerPWA();
  }
};

void bootstrap();
