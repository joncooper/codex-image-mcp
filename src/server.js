#!/usr/bin/env bun
import { argv, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { generateImageWithCodex, CodexImageError } from "./codex.js";
import { encodeMessage, MessageReader } from "./framing.js";

const SERVER_NAME = "codex-image-mcp";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";

const GENERATE_IMAGE_TOOL = {
  name: "generate_image",
  description: "Generate an image by delegating to Codex and requiring Codex to use its built-in image generation tool.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        description: "The image prompt to give Codex's image generation tool.",
      },
      outputDir: {
        type: "string",
        description: "Directory where the generated image should be written. Defaults to CODEX_IMAGE_OUTPUT_DIR or ./codex-images.",
      },
      filename: {
        type: "string",
        description: "Optional image filename. Path separators are not allowed. A missing image extension defaults to .png.",
      },
      aspectRatio: {
        type: "string",
        description: "Optional requested aspect ratio, such as 1:1, 16:9, or 9:16.",
      },
      size: {
        type: "string",
        description: "Optional requested output size.",
      },
      quality: {
        type: "string",
        description: "Optional quality guidance.",
      },
      style: {
        type: "string",
        description: "Optional style guidance.",
      },
      negativePrompt: {
        type: "string",
        description: "Optional details to avoid.",
      },
      referenceImages: {
        type: "array",
        description: "Optional local image paths to attach to the Codex request as references.",
        items: { type: "string" },
      },
      backend: {
        type: "string",
        enum: ["sdk", "cli"],
        description: "Codex backend to use. Defaults to sdk; cli keeps the raw codex exec fallback.",
      },
      model: {
        type: "string",
        description: "Optional Codex model override.",
      },
      profile: {
        type: "string",
        description: "Optional Codex profile. The SDK passes this through config; the cli backend passes --profile.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout for the Codex invocation.",
      },
      returnImageData: {
        type: "boolean",
        description: "When false, return only the generated file path and metadata instead of MCP image data.",
      },
    },
  },
};

class McpServer {
  constructor({ input = stdin, output = stdout } = {}) {
    this.output = output;
    this.reader = new MessageReader((message) => {
      this.handleMessage(message).catch((error) => {
        this.writeError(message.id, -32603, error.message);
      });
    });

    input.on("data", (chunk) => this.reader.push(chunk));
    input.on("error", (error) => {
      console.error(`${SERVER_NAME}: input error: ${error.message}`);
    });
  }

  async handleMessage(message) {
    if (!message || typeof message.method !== "string") {
      this.writeError(message?.id, -32600, "Invalid request");
      return;
    }

    if (message.method.startsWith("notifications/")) {
      return;
    }

    try {
      const result = await this.dispatch(message.method, message.params ?? {});
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.writeError(message.id, error.code, error.message);
        return;
      }

      throw error;
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        };

      case "ping":
        return {};

      case "tools/list":
        return {
          tools: [GENERATE_IMAGE_TOOL],
        };

      case "tools/call":
        return this.callTool(params);

      case "resources/list":
        return { resources: [] };

      case "prompts/list":
        return { prompts: [] };

      default:
        throw new ProtocolError(-32601, `Method not found: ${method}`);
    }
  }

  async callTool(params) {
    if (params.name !== GENERATE_IMAGE_TOOL.name) {
      throw new ProtocolError(-32602, `Unknown tool: ${params.name}`);
    }

    try {
      const result = await generateImageWithCodex(params.arguments ?? {});
      return formatImageResult(result);
    } catch (error) {
      const details = error instanceof CodexImageError ? error.details : {};
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: error.message,
              details,
            }, null, 2),
          },
        ],
      };
    }
  }

  write(message) {
    this.output.write(encodeMessage(message));
  }

  writeError(id, code, message) {
    if (id === undefined) {
      return;
    }

    this.write({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }
}

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function formatImageResult(result) {
  const metadata = {
    path: result.image.path,
    mimeType: result.image.mimeType,
    sizeBytes: result.image.sizeBytes,
    prompt: result.prompt,
    codex: result.codex,
  };

  const content = [
    {
      type: "text",
      text: JSON.stringify(metadata, null, 2),
    },
  ];

  if (result.imageContent) {
    content.push(result.imageContent);
  }

  return { content };
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  new McpServer();
}

export { McpServer, GENERATE_IMAGE_TOOL };
