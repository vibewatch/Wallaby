import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@wallaby/graby/node", replacement: fileURLToPath(new URL("./packages/graby/src/node.ts", import.meta.url)) },
      { find: "@wallaby/graby", replacement: fileURLToPath(new URL("./packages/graby/src/index.ts", import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL(".", import.meta.url)) },
    ],
  },
  test: {
    include: ["packages/**/*.test.ts", "lib/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
});
