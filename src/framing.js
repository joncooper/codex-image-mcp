export function encodeMessage(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

export class MessageReader {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk.toString("utf8");

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this.onMessage(JSON.parse(line));
      }
    }
  }
}
