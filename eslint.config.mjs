import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", ".test-build/**"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // node:test's test() returns a promise that is not meant to be awaited.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      // Path-handling tests use literal config-folder names as fixtures on
      // purpose: one of them asserts that ".obsidian" is NOT special-cased, so
      // the real Vault#configDir would defeat the test.
      "obsidianmd/hardcoded-config-path": "off",
    },
  },
]);
