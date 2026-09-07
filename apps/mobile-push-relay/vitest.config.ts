import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APNS_TEAM_ID: "TEAMTEST1",
          APNS_KEY_ID: "KEYTEST01",
          APNS_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
