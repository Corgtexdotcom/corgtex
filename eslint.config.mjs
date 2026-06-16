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
          selector: "Literal[value=/[\\p{Emoji_Presentation}\\uFE0F]/u], JSXText[value=/[\\p{Emoji_Presentation}\\uFE0F]/u], TemplateElement[value.raw=/[\\p{Emoji_Presentation}\\uFE0F]/u]",
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
  {
    // The Module Manifest registry is the pure, dependency-free layer: it must
    // stay types + plain data only so it is safe to import from the web client
    // bundle. Lock that contract in so a future edit cannot silently pull Prisma
    // or other runtime dependencies into the client. Tests are exempt (they
    // legitimately cross-check against the runtime SCOPE_REGISTRY / control plane).
    files: [
      "packages/domain/src/modules/**/*.ts",
      "packages/domain/src/modules/**/*.tsx",
    ],
    ignores: [
      "packages/domain/src/modules/**/*.test.ts",
      "packages/domain/src/modules/**/*.test.tsx",
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
            {
              group: [
                "@corgtex/shared",
                "@corgtex/shared/*",
                "@prisma/client",
                "@corgtex/domain",
                "@corgtex/domain/*",
                "../*",
                "../**",
              ],
              message:
                "packages/domain/src/modules is the pure Module Manifest layer (types + plain data only, safe for the web client bundle). Do not import Prisma, @corgtex/shared, the @corgtex/domain barrel, or sibling runtime domain files - keep imports within ./modules.",
            },
          ],
        },
      ],
    },
  },
];
