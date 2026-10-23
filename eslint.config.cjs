const js = require("@eslint/js");
const globals = require("globals");
const ts = require("typescript-eslint");

module.exports = ts.config(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  ts.configs.eslintRecommended,
  {
    files: ["**/*.ts"],
    languageOptions: { parser: ts.parser },
    plugins: { "@typescript-eslint": ts.plugin },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
