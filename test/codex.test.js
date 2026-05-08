import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildCodexCommand,
  buildCodexImagePrompt,
  buildCodexSdkInput,
  buildCodexSdkOptions,
  generateImageWithCodex,
  resolveFilename,
} from "../src/codex.js";

const ONE_BY_ONE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("buildCodexCommand uses codex exec with schema and last-message output", () => {
  const command = buildCodexCommand({
    env: {
      CODEX_IMAGE_CODEX_BIN: "codex",
      CODEX_IMAGE_CODEX_ARGS: JSON.stringify(["--config", "model=\"gpt-5.5\""]),
    },
    profile: "image-profile",
    model: "gpt-5.5",
    outputDir: "/tmp/images",
    outputSchemaPath: "/tmp/schema.json",
    outputLastMessagePath: "/tmp/last.json",
    referenceImages: ["./reference.png"],
  });

  assert.equal(command.bin, "codex");
  assert.deepEqual(command.args.slice(0, 4), ["--config", "model=\"gpt-5.5\"", "exec", "--skip-git-repo-check"]);
  assert.ok(command.args.includes("--output-schema"));
  assert.ok(command.args.includes("/tmp/schema.json"));
  assert.ok(command.args.includes("-o"));
  assert.ok(command.args.includes("/tmp/last.json"));
  assert.ok(command.args.includes("--profile"));
  assert.ok(command.args.includes("image-profile"));
  assert.ok(command.args.includes("--model"));
  assert.ok(command.args.includes("gpt-5.5"));
  assert.ok(command.args.includes(resolve("./reference.png")));
  assert.equal(command.args.at(-1), "-");
});

test("buildCodexImagePrompt instructs Codex to use image generation and save the target path", () => {
  const prompt = buildCodexImagePrompt({
    prompt: "a glass lighthouse at dawn",
    targetPath: "/tmp/images/lighthouse.png",
    aspectRatio: "16:9",
  });

  assert.match(prompt, /image_gen|imagen/i);
  assert.match(prompt, /TARGET_IMAGE_PATH: \/tmp\/images\/lighthouse\.png/);
  assert.match(prompt, /a glass lighthouse at dawn/);
  assert.match(prompt, /16:9/);
});

test("buildCodexSdkOptions maps MCP inputs to Codex SDK options", () => {
  const options = buildCodexSdkOptions({
    input: { profile: "image-profile" },
    env: {
      CODEX_IMAGE_CODEX_BIN: "/usr/local/bin/codex",
      CODEX_IMAGE_CODEX_CONFIG: JSON.stringify({
        model_reasoning_effort: "high",
      }),
      OPENAI_BASE_URL: "https://api.example.test/v1",
      OPENAI_API_KEY: "test-key",
    },
  });

  assert.deepEqual(options, {
    codexPathOverride: "/usr/local/bin/codex",
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    config: {
      model_reasoning_effort: "high",
      profile: "image-profile",
    },
  });
});

test("buildCodexSdkInput attaches reference images as local_image entries", () => {
  const input = buildCodexSdkInput("Generate an image", ["./reference.png"]);
  assert.deepEqual(input, [
    { type: "text", text: "Generate an image" },
    { type: "local_image", path: resolve("./reference.png") },
  ]);
});

test("generateImageWithCodex uses the Codex SDK backend by default", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "codex-image-sdk-"));
  const calls = [];

  class FakeCodex {
    constructor(options) {
      calls.push({ type: "constructor", options });
    }

    startThread(options) {
      calls.push({ type: "startThread", options });
      return {
        id: "thread-fake",
        run: async (input, options) => {
          calls.push({ type: "run", input, options });
          const prompt = Array.isArray(input) ? input[0].text : input;
          const targetPath = prompt.match(/^TARGET_IMAGE_PATH:\s*(.+)$/m)?.[1]?.trim();
          await mkdir(dirname(targetPath), { recursive: true });
          await writeFile(targetPath, Buffer.from(ONE_BY_ONE_PNG, "base64"));
          return {
            finalResponse: JSON.stringify({
              ok: true,
              message: "fake sdk image generated",
              images: [
                {
                  path: targetPath,
                  mimeType: "image/png",
                  revisedPrompt: "fake revised prompt",
                },
              ],
            }),
            usage: null,
            items: [],
          };
        },
      };
    }
  }

  try {
    const result = await generateImageWithCodex({
      prompt: "a small blue cube",
      outputDir,
      filename: "cube.png",
      returnImageData: false,
    }, {
      CodexClass: FakeCodex,
      env: {},
    });

    assert.equal(result.codex.backend, "sdk");
    assert.equal(result.codex.threadId, "thread-fake");
    assert.equal(result.image.path, join(outputDir, "cube.png"));
    assert.equal(result.image.mimeType, "image/png");
    assert.ok((await stat(join(outputDir, "cube.png"))).size > 0);
    assert.deepEqual(calls[1], {
      type: "startThread",
      options: {
        workingDirectory: outputDir,
        skipGitRepoCheck: true,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        model: undefined,
      },
    });
    assert.equal(calls[2].options.outputSchema.properties.images.items.required.includes("revisedPrompt"), true);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("resolveFilename rejects nested paths and adds a default image extension", () => {
  assert.equal(resolveFilename("example", "ignored"), "example.png");
  assert.throws(() => resolveFilename("../example.png", "ignored"), /path separators/);
});
