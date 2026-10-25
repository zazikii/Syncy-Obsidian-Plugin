import process from "node:process";
import esbuild from "esbuild";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  banner: {
    js: [
      "/* Syncy for Obsidian",
      " * Required Notice: Copyright (c) 2026 Syncy contributors",
      " * PolyForm Noncommercial License 1.0.0",
      " * https://polyformproject.org/licenses/noncommercial/1.0.0",
      " */",
    ].join("\n"),
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr"],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
