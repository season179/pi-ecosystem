// Bundle the extension entry into a single ESM file at dist/herdr.bundle.js.
//
// Why: Pi's loader imports package entries through jiti, which delegates
// "type":"module" .js entries to Node's native ESM loader. Node caches module
// graphs by URL for the process lifetime, so a multi-file dist cannot be
// re-evaluated after /reload (relative imports of a query-busted entry resolve
// back to their original URLs). One bundle file is one URL, which index.js can
// re-import under a content-hash query after every rebuild.
//
// The bundle must stay at the dist root: src resolves ../docs and ../skills
// through import.meta.url, and those relative paths must keep pointing at the
// package root's docs/ and skills/ directories.
//
// packages: "external" keeps every node_modules import external (the package
// has no runtime dependencies; its pi/typebox peers resolve at load time from
// the host), so bundled code shares module identities with the host process
// instead of vendoring second copies.
import { build } from "esbuild";

await build({
	entryPoints: ["src/extensions/herdr.ts"],
	outfile: "dist/herdr.bundle.js",
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	packages: "external",
	sourcemap: "linked",
	logLevel: "info",
});
