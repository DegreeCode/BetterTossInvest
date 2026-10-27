import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--tag")) {
    throw new Error("Usage: node scripts/check.mjs [--tag vMAJOR.MINOR.PATCH]");
  }
  const { version } = await build({ tag: args[1] });
  console.log(`Built release files for ${version}.`);
  const run = (...arguments_) => execFileSync(process.execPath, arguments_, { cwd: root, stdio: "inherit" });
  run("--check", "dist/BetterTossInvest.user.js");
  run("--check", "dist/BetterTossInvest.meta.js");
  const tests = (await readdir(new URL("../tests/", import.meta.url)))
    .filter((name) => name.endsWith(".test.cjs"))
    .sort()
    .map((name) => `tests/${name}`);
  if (tests.length === 0) throw new Error("No regression tests found.");
  run("--test", ...tests);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
