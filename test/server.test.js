import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeMessage, MessageReader } from "../src/framing.js";

test("MCP server lists and calls generate_image with a Codex-compatible command", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "codex-image-mcp-"));
  const serverPath = resolve("src/server.js");
  const fakeCodexPath = resolve("fixtures/fake-codex.js");
  const child = spawn(process.execPath, [serverPath], {
    cwd: resolve("."),
    env: {
      ...process.env,
      CODEX_IMAGE_BACKEND: "cli",
      CODEX_IMAGE_CODEX_BIN: process.execPath,
      CODEX_IMAGE_CODEX_ARGS: JSON.stringify([fakeCodexPath]),
      CODEX_IMAGE_OUTPUT_DIR: outputDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const responses = [];
  const reader = new MessageReader((message) => responses.push(message));
  child.stdout.on("data", (chunk) => reader.push(chunk));

  try {
    child.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }));

    const initialized = await waitForResponse(responses, 1);
    assert.equal(initialized.result.serverInfo.name, "codex-image-mcp");

    child.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }));

    child.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }));

    const tools = await waitForResponse(responses, 2);
    assert.equal(tools.result.tools[0].name, "generate_image");

    child.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "a small blue cube",
          filename: "cube.png",
        },
      },
    }));

    const result = await waitForResponse(responses, 3);
    assert.equal(result.result.isError, undefined);
    assert.equal(result.result.content[0].type, "text");
    assert.equal(result.result.content[1].type, "image");
    assert.equal(result.result.content[1].mimeType, "image/png");

    const metadata = JSON.parse(result.result.content[0].text);
    assert.equal(metadata.path, join(outputDir, "cube.png"));
    assert.equal(metadata.mimeType, "image/png");
    assert.equal(metadata.codex.backend, "cli");
    assert.ok(metadata.codex.command.includes("exec"));

    const imageStat = await stat(join(outputDir, "cube.png"));
    assert.ok(imageStat.size > 0);
  } finally {
    child.kill("SIGTERM");
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function waitForResponse(responses, id) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const response = responses.find((message) => message.id === id);
    if (response) {
      return response;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }

  throw new Error(`Timed out waiting for response ${id}`);
}
