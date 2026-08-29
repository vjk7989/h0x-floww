import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/wasm server deps stay out of the bundle: Mastra's storage drivers
  // (libsql, duckdb) and the app-generation defaults (esbuild syntax-checks
  // generated islands; PGlite's Emscripten module breaks under production
  // chunking).
  serverExternalPackages: [
    // Not a dependency of this example: @mastra/core reaches @ast-grep/napi
    // through a dynamic import it already degrades without, and declares the
    // addon only as a devDependency. So this entry is inert wherever the addon
    // is absent, and the only thing that keeps the build alive wherever some
    // other package in the install brought it in — Turbopack cannot place a
    // .node binary in an ESM chunk.
    "@ast-grep/napi",
    "@duckdb/node-api",
    "@electric-sql/pglite",
    "@libsql/client",
    // --- vendo: @vendoai/apps is the load-bearing entry. The checker reaches
    // esbuild through a VARIABLE specifier the bundler cannot see, so an
    // "esbuild" entry alone is inert — this only ever worked because the
    // monorepo root hoists esbuild. @vendoai/store loads PGlite, which breaks
    // under production chunking. Both are required: `vendo doctor` fails
    // E-CFG-004 on any name missing from the list init writes.
    "@vendoai/apps",
    "@vendoai/store",
    // --- /vendo
    "esbuild",
  ],
};

export default nextConfig;
