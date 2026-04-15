import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Plugin to bypass restrictive exports field in @actions/cache
// The package only exports "." but we need subpath imports like
// @actions/cache/lib/internal/cacheUtils, tar, constants
const resolveActionsCacheSubpaths = {
  name: "resolve-actions-cache-subpaths",
  setup(build) {
    build.onResolve({ filter: /^@actions\/cache\// }, (args) => {
      const subpath = args.path.slice("@actions/cache/".length);
      const resolved = path.join(
        __dirname,
        "node_modules",
        "@actions",
        "cache",
        subpath
      );
      return {
        path: resolved + ".js",
      };
    });
  },
};

const entries = ["restore", "save", "saveOnly"];

for (const entry of entries) {
  await esbuild.build({
    entryPoints: [`src/${entry}.ts`],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: `dist/${entry}/index.js`,
    plugins: [resolveActionsCacheSubpaths],
  });
  console.log(`Built dist/${entry}/index.js`);
}

// Bundle the download worker as a standalone script.
// The main download.ts resolves it at runtime as dist/download-worker/index.js.
await esbuild.build({
  entryPoints: ["src/download-worker.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/download-worker/index.js",
  plugins: [resolveActionsCacheSubpaths],
});
console.log("Built dist/download-worker/index.js");

console.log("Build complete");
