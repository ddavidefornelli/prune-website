import js from "@eslint/js";
import ts from "typescript-eslint";
import solid from "eslint-plugin-solid";

export default ts.config(
  { ignores: ["dist/**", ".playwright-dist/**", ".playwright-dist-survey/**", ".vercel/**", "node_modules/**"] },
  {
    files: ["{src,server}/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...ts.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [solid.configs["flat/typescript"]],
    rules: {
      // Mutation and lifecycle event callbacks intentionally read current signal values.
      "solid/reactivity": ["error", { customReactiveFunctions: ["mutate", "onWake"] }],
      "solid/no-innerhtml": "error",
    },
  },
);
