import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcRoot = path.join(root, "src");
const files = walk(srcRoot).filter((file) => file.endsWith(".js"));
const frontendRoot = path.join(root, "public", "src");
const frontendFiles = walk(frontendRoot).filter((file) => file.endsWith(".js"));
const violations = [];
const forbiddenByLayer = {
  domain: ["application", "infrastructure", "http", "bootstrap", "config"],
  shared: ["domain", "application", "infrastructure", "http", "bootstrap", "config"],
  application: ["infrastructure", "http", "bootstrap"],
  infrastructure: ["http", "bootstrap"],
  http: ["infrastructure", "bootstrap"]
};

for (const file of files) {
  const relative = path.relative(srcRoot, file);
  const [layer] = relative.split(path.sep);
  const source = fs.readFileSync(file, "utf8");
  const lineCount = source.split(/\r?\n/).length;
  if (lineCount > 450) violations.push(`${relative}: ${lineCount} lines exceeds the 450-line module budget.`);
  const imports = [...source.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
  for (const specifier of imports.filter((item) => item.startsWith("."))) {
    const target = path.resolve(path.dirname(file), specifier);
    const targetRelative = path.relative(srcRoot, target);
    const [targetLayer] = targetRelative.split(path.sep);
    if (forbiddenByLayer[layer]?.includes(targetLayer)) {
      violations.push(`${relative}: ${layer} cannot import ${targetLayer} (${specifier}).`);
    }
  }
}

for (const file of frontendFiles) {
  const relative = path.relative(frontendRoot, file);
  const lineCount = fs.readFileSync(file, "utf8").split(/\r?\n/).length;
  if (lineCount > 450) violations.push(`public/src/${relative}: ${lineCount} lines exceeds the 450-line module budget.`);
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Architecture check passed for ${files.length} backend and ${frontendFiles.length} frontend modules.`);
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
