import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The fixture trees are inputs the lint reads from disk, and one of them is
    // deliberately broken. Vitest must never try to collect them as suites.
    exclude: ["node_modules/**", "dist/**", "test/fixtures/**"],
  },

  pack: {
    // Two entries, not one. `cli.ts` spawns its transform by path —
    // `path.join(here, "transform" + selfExt)` — so `transform.js` has to land
    // beside `cli.js` as a real file that promptfoo can load by URL. `unbundle`
    // keeps the rest of the module graph 1:1 with `src/`, which is what the
    // committed `tsc` output used to be.
    entry: ["src/cli.ts", "src/transform.ts"],
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
