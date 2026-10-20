import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const cssPath = root + "web/app/globals.css";
await rm(root + "dist", { recursive: true, force: true });
await mkdir(root + "dist", { recursive: true });
await build({
  entryPoints: [root + "web/entry.tsx"],
  outfile: root + "dist/library.js",
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = await postcss([tailwind()]).process(
  await readFile(cssPath, "utf8"),
  { from: cssPath },
);
await writeFile(root + "dist/library.css", css.css);
// Deploy the existing site and the new native tab together as one Pages artifact.
await rm(root + "site", { recursive: true, force: true });
await mkdir(root + "site", { recursive: true });
for (const name of ["index.html", "app.js", "styles.css", "data"])
  await cp(root + "../" + name, root + "site/" + name, { recursive: true });
await cp(root + "dist", root + "site", { recursive: true });
console.log(
  "Built original Comment Reader + native royal library tab in recommend/site",
);
