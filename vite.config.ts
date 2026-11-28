import uinaf, { env, ignorePatterns } from "@uinaf/oxlint-config/vite-plus";
import { defineConfig } from "vite-plus";

const stableShell = {
  env: ["CI", "NODE_ENV"],
  untrackedEnv: ["INIT_CWD", "SHLVL"],
};

const graphInputs = [
  ".node-version",
  ".releaserc.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
];

export default defineConfig({
  run: {
    tasks: {
      format: {
        cache: {
          ...stableShell,
          input: [
            ...graphInputs,
            ".github/**",
            "docs/**",
            "scripts/**",
            "src/**",
            "test/**",
            "*.md",
          ],
        },
        command: "vp fmt --check",
      },
      lint: {
        cache: {
          ...stableShell,
          input: [...graphInputs, "scripts/**", "src/**", "test/**/*.ts"],
        },
        command: "vp lint",
      },
      pack: {
        cache: {
          ...stableShell,
          input: [...graphInputs, "src/**"],
          output: ["dist/**"],
        },
        command: "vp pack",
      },
      test: {
        cache: {
          ...stableShell,
          input: [
            ...graphInputs,
            "dist/**",
            "src/**",
            "scripts/**",
            "test/release-commit.test.ts",
            "test/cli.test.ts",
            "test/grok-provider.test.ts",
            "test/transform.test.ts",
            "test/trials.test.ts",
            "test/fixtures/**",
          ],
          output: [],
        },
        command:
          "vp test run test/cli.test.ts test/grok-provider.test.ts test/release-commit.test.ts test/transform.test.ts test/trials.test.ts",
        dependsOn: ["pack"],
      },
      consumer: {
        cache: {
          ...stableShell,
          input: [...graphInputs, "dist/**", "test/consumer.test.ts", "test/fixtures/clean/**"],
          output: [],
        },
        command: "vp test run test/consumer.test.ts",
        dependsOn: ["pack"],
      },
      ready: {
        cache: false,
        command: 'node -e ""',
        dependsOn: ["consumer", "format", "lint", "test"],
      },
    },
  },

  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "test/fixtures/**"],
  },

  pack: {
    entry: ["src/cli.ts", "src/transform.ts", "src/grok-provider.ts", "src/skill-evidence.ts"],
    unbundle: true,
    platform: "node",
    format: ["esm"],
    fixedExtension: false,
    dts: false,
    sourcemap: false,
  },

  fmt: {
    ignorePatterns: ["dist/**", "test/fixtures/**", "pnpm-lock.yaml"],
  },

  lint: {
    extends: [uinaf],
    env,
    ignorePatterns: [...ignorePatterns, "dist/**", "test/fixtures/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "unicorn/consistent-function-scoping": "off",
      "anti-slop/no-runtime-typeof": "off",
      "anti-slop/no-unknown-parameters": "off",
      "quality/no-array-filter-map": "off",
      "anti-slop/require-safety-comment-for-type-assertion": "off",
      "uinaf/no-comments": "off",
      "quality/no-known-value-widening": "off",
      "unicorn/prefer-import-meta-properties": "off",
      "no-promise-executor-return": "off",
      "quality/no-conditional-empty-object-spread": "off",
      "quality/no-unsafe-dictionary-type": "off",
      "import/consistent-type-specifier-style": "off",
      "quality/no-object-parameters": "off",
      "no-regex-spaces": "off",
      "no-console": "off",
      "quality/no-unknown-returns": "off",
      "typescript/no-unsafe-return": "off",
      "typescript/no-unsafe-member-access": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unsafe-assignment": "off",
      "typescript/no-unsafe-call": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },

  staged: {
    "*": "vp check --fix",
  },
});
