const HEADER_SEPARATOR = "\r\n\r\n";

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}${HEADER_SEPARATOR}`, "ascii");
  return Buffer.concat([header, body]);
}

export class MessageReader {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const parsed = this.#tryReadMessage();
      if (parsed === null) {
        return;
      }

      this.onMessage(parsed);
    }
  }

  #tryReadMessage() {
    const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
    if (headerEnd === -1) {
      return null;
    }

    const header = this.buffer.subarray(0, headerEnd).toString("ascii");
    const contentLength = readContentLength(header);
    const bodyStart = headerEnd + Buffer.byteLength(HEADER_SEPARATOR);
    const bodyEnd = bodyStart + contentLength;

    if (this.buffer.length < bodyEnd) {
      return null;
    }

    const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    this.buffer = this.buffer.subarray(bodyEnd);
    return JSON.parse(body);
  }
}

function readContentLength(header) {
  for (const line of header.split("\r\n")) {
    const [name, ...valueParts] = line.split(":");
    if (name.toLowerCase() === "content-length") {
      const value = Number.parseInt(valueParts.join(":").trim(), 10);
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
  }

  throw new Error("Missing Content-Length header");
}
