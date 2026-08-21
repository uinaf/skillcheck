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
    // Three entries, not one. `cli.ts` hands promptfoo file URLs built from
    // its own directory — `path.join(here, "transform" + selfExt)` and the
    // cursor provider alike — so both modules have to land beside `cli.js` as
    // real files promptfoo can load by URL. `unbundle` keeps the rest of the
    // module graph 1:1 with `src/`, which is what the committed `tsc` output
    // used to be.
    entry: ["src/cli.ts", "src/transform.ts", "src/cursor-provider.ts"],
    unbundle: true,
    platform: "node",
    format: ["esm"],
    // The package is `type: module`, so `.js` is already ESM. tsdown would
    // otherwise emit `.mjs` and silently move the `bin` target.
    fixedExtension: false,
    // Nothing imports this package; it is a bin. Declarations would be shipped
    // weight with no consumer.
    dts: false,
    sourcemap: false,
  },

  fmt: {
    ignorePatterns: ["dist/**", "test/fixtures/**", "pnpm-lock.yaml"],
  },

  lint: {
    // `test/fixtures/` is fixture content, not source: a SKILL.md the lint is
    // supposed to reject is not a file the linter here should have opinions on.
    ignorePatterns: ["dist/**", "test/fixtures/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },

  staged: {
    "*": "vp check --fix",
  },
});
