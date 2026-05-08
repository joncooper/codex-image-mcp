# codex-image-mcp

An MCP server that exposes a `generate_image` tool and delegates the actual image generation to Codex. The server asks Codex to use its built-in image generation tool (`image_gen` / Imagen), requires Codex to copy the generated artifact to a local image file, and returns that file as MCP image content.

The default backend uses the official `@openai/codex-sdk` TypeScript library. The SDK still requires the local Codex CLI, but it gives this server a supported programmatic surface for threads, structured output, image attachments, working directory control, and configuration. A raw `codex exec` backend remains available as `backend: "cli"` or `CODEX_IMAGE_BACKEND=cli`.

## Requirements

- Bun 1.3 or newer
- A working `codex` CLI on `PATH`
- `bun install` run for this package
- Codex access to the image generation tool in the environment/profile you run

The current local Codex CLI uses `-p` as `--profile`, not prompt text. This server exposes `profile` as an optional tool argument and otherwise passes image instructions through the SDK or stdin-backed CLI fallback.

## Run

```sh
bun install
bun start
```

For an MCP client, configure the server with `bun` and the absolute path to `src/server.js`:

```json
{
  "mcpServers": {
    "codex-image": {
      "command": "bun",
      "args": ["/absolute/path/to/codex-image-mcp/src/server.js"],
      "env": {
        "CODEX_IMAGE_OUTPUT_DIR": "/absolute/path/to/generated-images"
      }
    }
  }
}
```

## Add to Claude Code

From this repository, install dependencies first:

```sh
bun install
```

Make sure the Codex CLI is available and signed in before adding the MCP:

```sh
codex --version
codex login
```

Add the server to Claude Code with local scope:

```sh
claude mcp add --scope local \
  -e CODEX_IMAGE_OUTPUT_DIR="$HOME/Pictures/codex-images" \
  codex-image -- bun "$PWD/src/server.js"
```

Use an absolute path to `src/server.js` if your checkout is somewhere else. The `local` scope keeps this MCP registration on your machine. Use `--scope project` only when you intentionally want a project-level MCP entry, and `--scope user` only when you want it available across your Claude Code projects.

Verify Claude Code can see it:

```sh
claude mcp list
claude mcp get codex-image
```

Then ask Claude Code to use the `codex-image` MCP tool. For example:

```text
Use the codex-image MCP to generate an image of a small red cube on a white background.
```

The generated files are written under `CODEX_IMAGE_OUTPUT_DIR` unless the tool call passes an explicit `outputDir`.

### Claude Code JSON

If you prefer JSON configuration, the equivalent stdio server definition is:

```json
{
  "command": "bun",
  "args": ["/absolute/path/to/codex-image-mcp/src/server.js"],
  "env": {
    "CODEX_IMAGE_OUTPUT_DIR": "/absolute/path/to/generated-images"
  }
}
```

You can add that JSON through Claude Code with:

```sh
claude mcp add-json --scope local codex-image '{"command":"bun","args":["/absolute/path/to/codex-image-mcp/src/server.js"],"env":{"CODEX_IMAGE_OUTPUT_DIR":"/absolute/path/to/generated-images"}}'
```

## Notes for Agents

If you are another coding agent installing or using this MCP on a user's machine, treat it as a local tool that can spend the user's Codex/image-generation quota and write image files to disk.

Recommended install flow:

```sh
git clone <repo-url> codex-image-mcp
cd codex-image-mcp
bun install
bun test
```

Before registering the MCP, verify prerequisites without changing global state:

```sh
bun --version
codex --version
```

Do not run `codex login`, change Claude Code MCP scope, or trigger a real image generation unless the user has asked you to do so or approved it. `codex login` may open an interactive auth flow, and real image generation can consume quota.

When adding this MCP to Claude Code, prefer local scope unless the user explicitly asks otherwise:

```sh
claude mcp add --scope local \
  -e CODEX_IMAGE_OUTPUT_DIR="$HOME/Pictures/codex-images" \
  codex-image -- bun "$PWD/src/server.js"
```

Agent considerations:

- Use absolute paths in MCP configuration when possible. `"$PWD/src/server.js"` is fine when you are running the command from this repository.
- Keep `CODEX_IMAGE_OUTPUT_DIR` outside source directories unless the user wants generated assets committed to a project.
- Do not use `--scope project` or write `.mcp.json` unless the user wants the MCP shared with that project.
- Default to the SDK backend. Use `backend: "cli"` or `CODEX_IMAGE_BACKEND=cli` only when debugging the SDK path or when the user requests the raw CLI fallback.
- For large images or automation, pass `returnImageData: false` so the MCP returns file metadata without embedding base64 image data in the tool response.
- If the environment is sandboxed and Codex or Claude Code cannot access auth files, network, or the output directory, surface that clearly and request the narrow permission needed.
- Generated output should be treated as user data. Do not delete, overwrite, or commit generated files unless the user asked for that.

## Tool

`generate_image`

Required arguments:

- `prompt`: image prompt to pass to Codex

Optional arguments:

- `outputDir`: directory for generated images
- `filename`: output filename; path separators are rejected
- `aspectRatio`, `size`, `quality`, `style`, `negativePrompt`: generation guidance included in the Codex prompt
- `referenceImages`: local image paths attached to the Codex SDK run, or passed to `codex exec --image` in CLI mode
- `backend`: `sdk` or `cli`; default `sdk`
- `model`: Codex model override
- `profile`: Codex profile override
- `timeoutMs`: Codex process timeout
- `returnImageData`: set to `false` to return only file metadata and path

## Environment

- `CODEX_IMAGE_BACKEND`: `sdk` or `cli`, default `sdk`
- `CODEX_IMAGE_CODEX_BIN`: Codex executable. For SDK mode this maps to `codexPathOverride`; for CLI mode it is the spawned executable.
- `CODEX_IMAGE_CODEX_CONFIG`: JSON object passed to the SDK `config` option
- `CODEX_IMAGE_CODEX_ARGS`: CLI backend only, JSON array of arguments inserted before `exec`
- `CODEX_IMAGE_CODEX_EXEC_ARGS`: CLI backend only, JSON array of extra arguments inserted into `codex exec`
- `CODEX_IMAGE_OUTPUT_DIR`: default output directory, default `./codex-images`
- `CODEX_IMAGE_TIMEOUT_MS`: default Codex timeout, default 10 minutes
- `CODEX_IMAGE_MAX_RETURN_BYTES`: max image size returned inline as MCP image content, default 12 MiB

Example:

```json
{
  "CODEX_IMAGE_CODEX_CONFIG": { "model_reasoning_effort": "high" },
  "CODEX_IMAGE_OUTPUT_DIR": "/tmp/codex-images"
}
```

## Test

```sh
bun test
```

The tests use a fake SDK class for the default backend and a fake Codex executable for the CLI fallback, so the MCP protocol and image-file contract are verified without spending image generation credits.
