#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ONE_BY_ONE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
const outputPath = outputIndex === -1 ? null : args[outputIndex + 1];

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  prompt += chunk;
}

const targetMatch = prompt.match(/^TARGET_IMAGE_PATH:\s*(.+)$/m);
const targetPath = targetMatch?.[1]?.trim();

if (!targetPath || !outputPath) {
  console.error("fake codex did not receive expected target or -o path");
  process.exit(2);
}

mkdirSync(dirname(targetPath), { recursive: true });
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(targetPath, Buffer.from(ONE_BY_ONE_PNG, "base64"));
writeFileSync(outputPath, JSON.stringify({
  ok: true,
  message: "fake image generated",
  images: [
    {
      path: targetPath,
      mimeType: "image/png",
      revisedPrompt: "fake revised prompt",
    },
  ],
}));

console.log("fake codex generated an image");
