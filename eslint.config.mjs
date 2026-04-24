import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default [
  ...compat.extends("next/core-web-vitals"),
  {
    ignores: [
      "**/.next/**",
      "coverage/**",
      "node_modules/**",
      "app/**",
      "components/**",
      "lib/**",
      "tests/**",
      "docs/**",
      "scripts/**",
    ],
  },
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/[\\p{Emoji_Presentation}\\uFE0F]/u]",
          message: "Emoji characters are not allowed. Use monochrome Unicode glyphs from the design system (see nav-config.ts for reference).",
        },
      ],
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: [
      "apps/web/**/*.ts",
      "apps/web/**/*.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app/*"],
              message: "Import shared helpers from '@/lib/*' or a package export instead of another app module path.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "packages/**/*.ts",
      "packages/**/*.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app/*", "@/lib/*", "apps/web/*", "apps/worker/*"],
              message: "Packages must not depend on app-layer modules.",
            },
          ],
        },
      ],
    },
  },
];
