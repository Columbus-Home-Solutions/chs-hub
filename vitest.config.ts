import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

// The Worker source uses explicit ".js" import specifiers (NodeNext/Bundler
// style) but the files are ".ts". Rewrite relative ".js" → ".ts" at resolve
// time so vitest can load the source graph directly.
export default defineConfig({
  plugins: [
    {
      name: "js-to-ts",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer && source.startsWith(".") && source.endsWith(".js")) {
          const tsPath = resolve(dirname(importer), source.replace(/\.js$/, ".ts"));
          if (existsSync(tsPath)) return tsPath;
        }
        return null;
      },
    },
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
