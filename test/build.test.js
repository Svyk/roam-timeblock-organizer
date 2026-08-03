import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build, verifyGeneratedArtifacts } from "../build.mjs";
import { scanSecrets } from "../scripts/scan-secrets.mjs";

test("build creates matching inert root and Pages artifacts", async () => {
  await build();
  const root = await readFile(new URL("../extension.js", import.meta.url), "utf8");
  const deploy = await readFile(new URL("../deploy/extension.js", import.meta.url), "utf8");
  assert.equal(root, deploy);
  await verifyGeneratedArtifacts();
  const loaded = await import(`${pathToFileURL(new URL("../extension.js", import.meta.url).pathname).href}?${Date.now()}`);
  assert.equal(typeof loaded.default.onload, "function");
});

test("secret scanner passes the repository", async () => {
  assert.deepEqual((await scanSecrets(new URL("../", import.meta.url).pathname)).findings, []);
});

