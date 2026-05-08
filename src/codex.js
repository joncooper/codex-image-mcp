import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETURN_BYTES = 12 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export class CodexImageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CodexImageError";
    this.details = details;
  }
}

export async function generateImageWithCodex(input, options = {}) {
  const env = options.env ?? process.env;
  const prompt = requireNonEmptyString(input.prompt, "prompt");
  const referenceImages = optionalStringArray(input.referenceImages, "referenceImages");
  const backend = resolveBackend(input.backend, env);
  const normalized = {
    prompt,
    outputDir: optionalString(input.outputDir, "outputDir"),
    filename: optionalString(input.filename, "filename"),
    aspectRatio: optionalString(input.aspectRatio, "aspectRatio"),
    size: optionalString(input.size, "size"),
    quality: optionalString(input.quality, "quality"),
    style: optionalString(input.style, "style"),
    negativePrompt: optionalString(input.negativePrompt, "negativePrompt"),
    model: optionalString(input.model, "model"),
    profile: optionalString(input.profile, "profile"),
    backend,
    referenceImages,
  };
  validateOptionalBoolean(input.returnImageData, "returnImageData");

  const outputDir = resolveOutputDir(normalized.outputDir, env);
  const filename = resolveFilename(normalized.filename, prompt);
  const targetPath = join(outputDir, filename);
  const jobDir = join(outputDir, ".codex-image-mcp", randomUUID());
  const schemaPath = join(jobDir, "codex-output.schema.json");
  const lastMessagePath = join(jobDir, "codex-last-message.json");
  const timeoutMs = resolveTimeout(input.timeoutMs, env);
  const startedAt = Date.now();

  await mkdir(jobDir, { recursive: true });
  await writeFile(schemaPath, JSON.stringify(codexOutputSchema(), null, 2));

  const imagePrompt = buildCodexImagePrompt({
    ...normalized,
    targetPath,
  });

  const processResult = backend === "sdk"
    ? await runCodexSdk({
      input: normalized,
      outputDir,
      imagePrompt,
      schema: codexOutputSchema(),
      env,
      timeoutMs,
      CodexClass: options.CodexClass,
    })
    : await runCodexCli({
      input: normalized,
      outputDir,
      imagePrompt,
      schemaPath,
      lastMessagePath,
      env,
      timeoutMs,
      spawnImpl: options.spawnImpl,
    });

  const finalMessage = processResult.finalMessage;

  if (finalMessage.ok === false) {
    throw new CodexImageError(finalMessage.message || "Codex reported that image generation is unavailable", {
      ...processResult.details,
      finalMessage,
    });
  }

  const image = await resolveGeneratedImage({
    finalMessage,
    targetPath,
    outputDir,
    startedAt,
  });

  if (!image) {
    throw new CodexImageError("Codex completed without producing a readable image file", {
      expectedPath: targetPath,
      ...processResult.details,
      finalMessage,
    });
  }

  const returnImageData = input.returnImageData !== false;
  const maxReturnBytes = resolveMaxReturnBytes(env);
  const imageContent = returnImageData && image.sizeBytes <= maxReturnBytes
    ? await readImageContent(image.path, image.mimeType)
    : null;

  return {
    prompt,
    image,
    imageContent,
    codex: {
      backend,
      elapsedMs: Date.now() - startedAt,
      ...processResult.details,
      finalMessage,
    },
  };
}

async function runCodexSdk({
  input,
  outputDir,
  imagePrompt,
  schema,
  env,
  timeoutMs,
  CodexClass,
}) {
  const Codex = CodexClass ?? await loadCodexSdk();
  const codex = new Codex(buildCodexSdkOptions({ input, env }));
  const thread = codex.startThread({
    workingDirectory: outputDir,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    model: input.model,
  });
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const turn = await thread.run(buildCodexSdkInput(imagePrompt, input.referenceImages), {
      outputSchema: schema,
      signal: abortController.signal,
    });

    return {
      finalMessage: parseJsonObject(turn.finalResponse),
      details: {
        threadId: thread.id,
        usage: turn.usage,
        items: turn.items,
      },
    };
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new CodexImageError("Codex image generation timed out", {
        backend: "sdk",
        timeoutMs,
      });
    }

    throw new CodexImageError(`Codex SDK image generation failed: ${error.message}`, {
      backend: "sdk",
      cause: error.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function runCodexCli({
  input,
  outputDir,
  imagePrompt,
  schemaPath,
  lastMessagePath,
  env,
  timeoutMs,
  spawnImpl,
}) {
  const command = buildCodexCommand({
    env,
    model: input.model,
    profile: input.profile,
    outputDir,
    outputSchemaPath: schemaPath,
    outputLastMessagePath: lastMessagePath,
    referenceImages: input.referenceImages,
  });

  const processResult = await runCodex(command, {
    cwd: outputDir,
    env,
    input: imagePrompt,
    timeoutMs,
    spawnImpl,
  });

  const finalMessage = await readFinalMessage(lastMessagePath, processResult.stdout);
  if (processResult.exitCode !== 0) {
    throw new CodexImageError("Codex image generation failed", {
      command: commandForDisplay(command),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      stdout: tail(processResult.stdout),
      stderr: tail(processResult.stderr),
      finalMessage,
    });
  }

  return {
    finalMessage,
    details: {
      command: commandForDisplay(command),
      stdout: tail(processResult.stdout),
      stderr: tail(processResult.stderr),
    },
  };
}

async function loadCodexSdk() {
  try {
    const sdk = await import("@openai/codex-sdk");
    return sdk.Codex;
  } catch (error) {
    throw new CodexImageError("Unable to load @openai/codex-sdk. Run npm install before using the SDK backend.", {
      backend: "sdk",
      cause: error.message,
    });
  }
}

export function buildCodexSdkOptions({ input, env = process.env }) {
  const sdkOptions = {};
  const config = {
    ...parseJsonObjectEnv(env.CODEX_IMAGE_CODEX_CONFIG, "CODEX_IMAGE_CODEX_CONFIG"),
  };

  if (env.CODEX_IMAGE_CODEX_BIN) {
    sdkOptions.codexPathOverride = env.CODEX_IMAGE_CODEX_BIN;
  }

  if (env.OPENAI_BASE_URL) {
    sdkOptions.baseUrl = env.OPENAI_BASE_URL;
  }

  if (env.OPENAI_API_KEY) {
    sdkOptions.apiKey = env.OPENAI_API_KEY;
  }

  if (input.profile) {
    config.profile = input.profile;
  }

  if (Object.keys(config).length > 0) {
    sdkOptions.config = config;
  }

  return sdkOptions;
}

export function buildCodexSdkInput(imagePrompt, referenceImages = []) {
  if (!referenceImages.length) {
    return imagePrompt;
  }

  return [
    { type: "text", text: imagePrompt },
    ...referenceImages.map((path) => ({
      type: "local_image",
      path: resolve(path),
    })),
  ];
}

export function buildCodexCommand({
  env = process.env,
  model,
  profile,
  outputDir,
  outputSchemaPath,
  outputLastMessagePath,
  referenceImages = [],
}) {
  const bin = env.CODEX_IMAGE_CODEX_BIN || "codex";
  const prefixArgs = parseJsonStringArray(env.CODEX_IMAGE_CODEX_ARGS, "CODEX_IMAGE_CODEX_ARGS");
  const execArgs = parseJsonStringArray(env.CODEX_IMAGE_CODEX_EXEC_ARGS, "CODEX_IMAGE_CODEX_EXEC_ARGS");
  const args = [
    ...prefixArgs,
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "--cd",
    outputDir,
    "--output-schema",
    outputSchemaPath,
    "-o",
    outputLastMessagePath,
    ...execArgs,
  ];

  if (profile) {
    args.push("--profile", profile);
  }

  if (model) {
    args.push("--model", model);
  }

  for (const referenceImage of referenceImages ?? []) {
    args.push("--image", resolve(referenceImage));
  }

  args.push("-");
  return { bin, args };
}

export function buildCodexImagePrompt(input) {
  const optionalSettings = [
    input.aspectRatio ? `- Aspect ratio: ${input.aspectRatio}` : null,
    input.size ? `- Size: ${input.size}` : null,
    input.quality ? `- Quality: ${input.quality}` : null,
    input.style ? `- Style: ${input.style}` : null,
    input.negativePrompt ? `- Negative prompt: ${input.negativePrompt}` : null,
    input.referenceImages?.length ? `- Reference images: ${input.referenceImages.map((value) => resolve(value)).join(", ")}` : null,
  ].filter(Boolean);

  const settingsBlock = optionalSettings.length > 0
    ? optionalSettings.join("\n")
    : "- No additional settings were supplied.";

  return [
    "You are being invoked by codex-image-mcp to create an image for an MCP client.",
    "",
    "Use Codex's built-in image generation tool only. The tool may be named image_gen, imagen, or image generation in your environment. Do not use external image APIs and do not synthesize a placeholder with code.",
    "",
    `TARGET_IMAGE_PATH: ${input.targetPath}`,
    "",
    "Image prompt:",
    input.prompt,
    "",
    "Generation settings:",
    settingsBlock,
    "",
    "Required behavior:",
    "1. Generate exactly one image from the prompt using the built-in image generation tool.",
    "2. The built-in tool may save under $CODEX_HOME/generated_images or another default Codex image directory. After generation, copy or move the selected real generated image to TARGET_IMAGE_PATH.",
    "3. Prefer PNG at TARGET_IMAGE_PATH unless the image generation tool gives you another real image format.",
    "4. Return only JSON matching the provided output schema. Include the absolute image path, MIME type, revisedPrompt as a string, and a short message.",
    "5. If image generation is unavailable, return schema-valid JSON with ok=false and a clear message.",
  ].join("\n");
}

export function resolveFilename(filename, prompt) {
  if (filename) {
    const clean = basename(filename);
    if (clean !== filename || filename.includes("/") || filename.includes("\\")) {
      throw new CodexImageError("filename must not include path separators", { filename });
    }

    return ensureImageExtension(clean);
  }

  const slug = slugify(prompt).slice(0, 56) || "codex-image";
  return `${new Date().toISOString().replaceAll(":", "-")}-${slug}.png`;
}

export function resolveOutputDir(outputDir, env = process.env) {
  const configured = outputDir || env.CODEX_IMAGE_OUTPUT_DIR || join(process.cwd(), "codex-images");
  return isAbsolute(configured) ? configured : resolve(configured);
}

export function codexOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["ok", "images", "message"],
    properties: {
      ok: { type: "boolean" },
      message: { type: "string" },
      images: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "mimeType", "revisedPrompt"],
          properties: {
            path: { type: "string" },
            mimeType: { type: "string" },
            revisedPrompt: { type: "string" },
          },
        },
      },
    },
  };
}

async function runCodex(command, options) {
  const spawnImpl = options.spawnImpl ?? spawn;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl(command.bin, command.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectOnce(new CodexImageError("Codex image generation timed out", {
        command: commandForDisplay(command),
        timeoutMs: options.timeoutMs,
        stdout: tail(stdout),
        stderr: tail(stderr),
      }));
    }, options.timeoutMs);

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      stdout = limitBuffer(stdout);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      stderr = limitBuffer(stderr);
    });

    child.on("error", (error) => {
      rejectOnce(new CodexImageError(`Unable to start Codex command: ${error.message}`, {
        command: commandForDisplay(command),
      }));
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ exitCode, signal, stdout, stderr });
    });

    child.stdin.end(options.input);
  });
}

async function readFinalMessage(path, stdout) {
  try {
    const content = await readFile(path, "utf8");
    return parseJsonObject(content);
  } catch {
    return parseJsonObject(stdout);
  }
}

async function resolveGeneratedImage({ finalMessage, targetPath, outputDir, startedAt }) {
  const candidates = [];

  for (const image of finalMessage?.images ?? []) {
    if (typeof image.path === "string") {
      candidates.push(image.path);
    }
  }

  candidates.push(targetPath);
  candidates.push(...await findRecentImages(outputDir, startedAt));

  for (const candidate of unique(candidates)) {
    const resolved = resolve(candidate);
    try {
      await access(resolved, fsConstants.R_OK);
      const fileStat = await stat(resolved);
      if (fileStat.isFile() && fileStat.size > 0 && IMAGE_EXTENSIONS.has(extname(resolved).toLowerCase())) {
        return {
          path: resolved,
          mimeType: detectMimeType(resolved),
          sizeBytes: fileStat.size,
        };
      }
    } catch {
      // Keep looking through the remaining candidates.
    }
  }

  return null;
}

async function findRecentImages(rootDir, startedAt) {
  const results = [];
  await walk(rootDir, async (entryPath, fileStat) => {
    if (fileStat.mtimeMs >= startedAt - 1000 && IMAGE_EXTENSIONS.has(extname(entryPath).toLowerCase())) {
      results.push(entryPath);
    }
  });
  return results;
}

async function walk(rootDir, onFile) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, onFile);
    } else if (entry.isFile()) {
      await onFile(entryPath, await stat(entryPath));
    }
  }
}

async function readImageContent(path, mimeType) {
  const chunks = [];
  for await (const chunk of createReadStream(path)) {
    chunks.push(chunk);
  }

  return {
    type: "image",
    data: Buffer.concat(chunks).toString("base64"),
    mimeType,
  };
}

function parseJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1));
    }
    return {};
  }
}

function detectMimeType(path) {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function resolveTimeout(inputTimeoutMs, env) {
  const value = inputTimeoutMs ?? env.CODEX_IMAGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CodexImageError("timeoutMs must be a positive number", { timeoutMs: value });
  }
  return parsed;
}

function resolveMaxReturnBytes(env) {
  const parsed = Number(env.CODEX_IMAGE_MAX_RETURN_BYTES ?? DEFAULT_MAX_RETURN_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RETURN_BYTES;
}

function resolveBackend(inputBackend, env) {
  const backend = inputBackend ?? env.CODEX_IMAGE_BACKEND ?? "sdk";
  if (backend !== "sdk" && backend !== "cli") {
    throw new CodexImageError("backend must be either sdk or cli", { backend });
  }

  return backend;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CodexImageError(`${name} is required`);
  }

  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new CodexImageError(`${name} must be a string`, { [name]: value });
  }

  return value;
}

function optionalStringArray(value, name) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new CodexImageError(`${name} must be an array of non-empty strings`, { [name]: value });
  }

  return value;
}

function validateOptionalBoolean(value, name) {
  if (value !== undefined && value !== null && typeof value !== "boolean") {
    throw new CodexImageError(`${name} must be a boolean`, { [name]: value });
  }
}

function parseJsonObjectEnv(raw, name) {
  if (!raw) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CodexImageError(`${name} must be a JSON object`, { cause: error.message });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CodexImageError(`${name} must be a JSON object`);
  }

  return parsed;
}

function parseJsonStringArray(raw, name) {
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CodexImageError(`${name} must be a JSON array of strings`, { cause: error.message });
  }

  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new CodexImageError(`${name} must be a JSON array of strings`);
  }

  return parsed;
}

function ensureImageExtension(filename) {
  const extension = extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    return filename;
  }

  return `${filename}.png`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function commandForDisplay(command) {
  return [command.bin, ...command.args].join(" ");
}

function tail(value, maxLength = 6000) {
  if (!value || value.length <= maxLength) {
    return value || "";
  }

  return value.slice(value.length - maxLength);
}

function limitBuffer(value, maxLength = 64_000) {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(value.length - maxLength);
}
