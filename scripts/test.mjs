import esbuild from "esbuild";
import { spawnSync } from "node:child_process";

const out = ".test-build/layout.test.mjs";
await esbuild.build({ entryPoints: ["tests/layout.test.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "warning" });
const res = spawnSync(process.execPath, ["--test", out], { stdio: "inherit" });
process.exit(res.status ?? 1);
