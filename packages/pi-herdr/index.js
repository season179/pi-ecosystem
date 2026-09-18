// Stable loader entry for the pi-herdr extension.
//
// Pi imports this file through jiti, which delegates "type":"module" .js
// entries to Node's native ESM loader; Node caches that module namespace for
// the whole process, so this file itself is evaluated once per process and
// must remain tiny and stable. Pi's /reload re-invokes the default factory
// with a fresh ExtensionAPI instead of re-importing the module, which is what
// this shim exploits: on every factory call it fingerprints the built bundle
// by content and imports it under a query-busted URL. A rebuilt bundle is
// re-evaluated in the same process; an unchanged bundle reuses Node's cached
// module for that hash. Changing this file itself still requires a restart.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const bundle = new URL("./dist/herdr.bundle.js", import.meta.url);

export default async function herdrEntry(pi) {
	const fingerprint = createHash("sha256")
		.update(readFileSync(bundle))
		.digest("hex")
		.slice(0, 16);
	const module = await import(`${bundle.href}?v=${fingerprint}`);
	return module.default(pi);
}
