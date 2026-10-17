// The portal's page scripts are plain browser scripts (no modules, no build step). Their pure parts are reachable
// without a page: each script returns before touching the DOM when there is no document. Here they run in a fresh
// context of their own, as a browser would run them, minus the page.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(new URL(import.meta.url).pathname);
export const STATIC = path.join(here, "..", "..", "portal", "static");

export function load(...files) {
  const ctx = vm.createContext({ console });
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(STATIC, f), "utf8"), ctx, { filename: f });
  return ctx;
}

// values from the scripts' context, as plain data of this one (another realm's arrays and objects)
export const plain = (x) => JSON.parse(JSON.stringify(x));

export const source = (f) => fs.readFileSync(path.join(STATIC, f), "utf8");
