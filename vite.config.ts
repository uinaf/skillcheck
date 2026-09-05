import { defineConfig } from "vite-plus";

const stableShell = {
  env: ["CI", "NODE_ENV"],
  untrackedEnv: ["INIT_CWD", "SHLVL"],
};

const graphInputs = [
  ".node-version",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
];

export default defineConfig({
  run: {
    tasks: {
      format: {
        ...stableShell,
        cache: true,
        command: "vp fmt --check",
        input: [...graphInputs, ".github/**", "docs/**", "src/**", "test/**", "*.md"],
      },
      lint: {
        ...stableShell,
        cache: true,
        command: "vp lint",
        input: [...graphInputs, "src/**", "test/**/*.ts"],
      },
      pack: {
        ...stableShell,
        cache: true,
        command: "vp pack",
        input: [...graphInputs, "src/**"],
        output: ["dist/**"],
      },
      test: {
        ...stableShell,
        cache: true,
        command: "vp test run test/cli.test.ts test/cursor-provider.test.ts",
        dependsOn: ["pack"],
        input: [
          ...graphInputs,
          "dist/**",
          "src/**",
          "test/cli.test.ts",
          "test/cursor-provider.test.ts",
          "test/fixtures/**",
        ],
        output: [],
      },
      consumer: {
        ...stableShell,
        cache: true,
        command: "vp test run test/consumer.test.ts",
        dependsOn: ["pack"],
        input: [...graphInputs, "dist/**", "test/consumer.test.ts", "test/fixtures/clean/**"],
        output: [],
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
    // The fixture trees are inputs the lint reads from disk, and one of them is
    // deliberately broken. Vitest must never try to collect them as suites.
    exclude: ["node_modules/**", "dist/**", "test/fixtures/**"],
  },

  pack: {
    // promptfoo loads the transform and Cursor provider by file URL. Both must
    // be real files beside cli.js. `unbundle` keeps the source layout 1:1.
    entry: ["src/cli.ts", "src/transform.ts", "src/cursor-provider.ts", "src/cursor-process.ts"],
    unbundle: true,
    platform: "node",
    format: ["esm"],
    // The package is `type: module`, so `.js` is already ESM. tsdown would
    // otherwise emit `.mjs` and silently move the `bin` target.
    fixedExtension: false,
    // This package exposes a binary, not an importable API.
    dts: false,
    sourcemap: false,
  },

  fmt: {
    ignorePatterns: ["dist/**", "test/fixtures/**", "pnpm-lock.yaml"],
  },

  lint: {
    // One fixture is deliberately invalid input for skillcheck itself.
    ignorePatterns: ["dist/**", "test/fixtures/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },

  staged: {
    "*": "vp check --fix",
  },
});
