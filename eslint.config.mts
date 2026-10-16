import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "dist/**", "node_modules/**", "*.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.mts", "vitest.config.ts"] },
      },
    },
  },
  {
    // Tests and the Node recovery CLI are not part of the plugin bundle.
    files: ["tests/**", "src/cli/**", "vitest.config.ts"],
    languageOptions: { globals: { process: "readonly", NodeJS: "readonly" } },
    rules: {
      "import/no-nodejs-modules": "off",
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/rule-custom-message": "off",
    },
  },
]);
