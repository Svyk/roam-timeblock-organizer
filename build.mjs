import { build as esbuild } from "esbuild";
import { copyFile, mkdir, readFile, rm, watch, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const root = dirname(thisFile);

export async function renderArtifacts(rootDirectory = root) {
  const metadata = JSON.parse(await readFile(resolve(rootDirectory, "package.json"), "utf8"));
  const result = await esbuild({
    absWorkingDir: rootDirectory,
    entryPoints: ["src/extension.js"],
    outfile: "extension.js",
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    sourcemap: false,
    legalComments: "none",
    minify: false,
    logLevel: "silent",
    banner: { js: `/* ${metadata.displayName} v${metadata.version} | MIT | generated from src/ */` },
  });
  return {
    javascript: result.outputFiles.find((file) => file.path.endsWith("extension.js")).text,
    css: await readFile(resolve(rootDirectory, "src/extension.css"), "utf8"),
  };
}

export async function build(rootDirectory = root) {
  const artifacts = await renderArtifacts(rootDirectory);
  const deploy = resolve(rootDirectory, "deploy");
  await Promise.all([
    writeFile(resolve(rootDirectory, "extension.js"), artifacts.javascript),
    writeFile(resolve(rootDirectory, "extension.css"), artifacts.css),
  ]);
  await rm(deploy, { recursive: true, force: true });
  await mkdir(deploy, { recursive: true });
  await Promise.all([
    writeFile(resolve(deploy, "extension.js"), artifacts.javascript),
    writeFile(resolve(deploy, "extension.css"), artifacts.css),
    ...["README.md", "CHANGELOG.md", "LICENSE"].map((name) => copyFile(resolve(rootDirectory, name), resolve(deploy, name))),
    writeFile(resolve(deploy, ".nojekyll"), ""),
  ]);
}

export async function verifyGeneratedArtifacts(rootDirectory = root) {
  const expected = await renderArtifacts(rootDirectory);
  const pairs = [["extension.js", expected.javascript], ["extension.css", expected.css], ["deploy/extension.js", expected.javascript], ["deploy/extension.css", expected.css]];
  for (const [name, content] of pairs) {
    if (await readFile(resolve(rootDirectory, name), "utf8") !== content) throw new Error(`Generated artifact drift: ${name}`);
  }
}

async function main() {
  await build();
  if (!process.argv.includes("--watch")) return;
  for await (const event of watch(resolve(root, "src"), { recursive: true })) {
    if (event.filename && /\.(js|css)$/.test(event.filename)) await build();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === thisFile) await main();

