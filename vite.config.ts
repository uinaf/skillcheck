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
        ...stableShell,
        cache: true,
        command: "vp fmt --check",
        input: [...graphInputs, ".github/**", "docs/**", "scripts/**", "src/**", "test/**", "*.md"],
      },
      lint: {
        ...stableShell,
        cache: true,
        command: "vp lint",
        input: [...graphInputs, "scripts/**", "src/**", "test/**/*.ts"],
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
        command:
          "vp test run test/cli.test.ts test/grok-provider.test.ts test/release-commit.test.ts test/transform.test.ts test/trials.test.ts",
        dependsOn: ["pack"],
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
    exclude: ["node_modules/**", "dist/**", "test/fixtures/**"],
  },

  pack: {
    entry: ["src/cli.ts", "src/transform.ts", "src/grok-provider.ts"],
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
    ignorePatterns: ["dist/**", "test/fixtures/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },

  staged: {
    "*": "vp check --fix",
  },
});
