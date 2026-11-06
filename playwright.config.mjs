import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3321",
    headless: true,
    launchOptions: {
      args: [
        "--no-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:3321/health",
    reuseExistingServer: false,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
});
