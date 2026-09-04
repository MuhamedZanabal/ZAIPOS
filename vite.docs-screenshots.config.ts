import path from "node:path";
import { defineConfig } from "vite";
import productionConfig from "./vite.config";

export default defineConfig(async (env) => {
  const configured = typeof productionConfig === "function"
    ? await productionConfig(env)
    : productionConfig;

  const existingAlias = configured.resolve?.alias;
  const alias = Array.isArray(existingAlias)
    ? [
        {
          find: "@/integrations/supabase/client",
          replacement: path.resolve(__dirname, "scripts/screenshot-fixture/supabase.ts"),
        },
        ...existingAlias,
      ]
    : {
        "@/integrations/supabase/client": path.resolve(
          __dirname,
          "scripts/screenshot-fixture/supabase.ts",
        ),
        ...(existingAlias ?? {}),
      };

  return {
    ...configured,
    server: {
      ...configured.server,
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
    },
    resolve: {
      ...configured.resolve,
      alias,
    },
  };
});
