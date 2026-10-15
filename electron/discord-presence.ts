import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TouchBarStatePayload } from "./touchbar.js";

// minimal discord rich presence over discord's local ipc socket (no dependency).
// frame = int32le opcode + int32le length + json; docs: discord.com/developers/docs/topics/rpc
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;
const RETRY_MS = 15_000;
const LISTENING = 2;
// discord shows up to 2 buttons (label <= 32 chars), only to people viewing the profile, not to yourself
const BUTTONS = [
  { label: "Download Liner", url: "https://github.com/tryliner/desktop/releases" },
];

export function encodeFrame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

export function defaultIpcPaths(): string[] {
  const dir =
    process.platform === "win32"
      ? "\\\\?\\pipe"
      : (process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || "/tmp").replace(/\/+$/, "");
  return Array.from({ length: 10 }, (_, i) =>
    process.platform === "win32" ? `${dir}\\discord-ipc-${i}` : path.join(dir, `discord-ipc-${i}`),
  );
}

// discord rejects details/state outside 2..128 chars
const field = (s: string) => s.trim().slice(0, 128).padEnd(2, "​");

// null = clear the presence (paused, stopped, nothing loaded)
export function buildActivity(state: TouchBarStatePayload, now: number): Record<string, unknown> | null {
  const track = state.track;
  if (!track?.title || !["playing", "buffering", "loading"].includes(state.status)) return null;
  const durationMs = state.durationMs || track.durationMs || 0;
  const start = now - Math.max(0, state.positionMs || 0);
  const cover = track.cover && /^https:\/\//.test(track.cover) && track.cover.length <= 256 ? track.cover : undefined;
  return {
    type: LISTENING,
    details: field(track.title),
    state: field(track.artist || "Liner"),
    timestamps: durationMs > 0 ? { start, end: start + durationMs } : { start },
    ...(cover ? { assets: { large_image: cover, large_text: field(track.album || track.title) } } : {}),
    buttons: BUTTONS,
  };
}

export class DiscordPresence {
  private sock: net.Socket | null = null;
  private ready = false;
  private inbox = Buffer.alloc(0);
  private retryAt = 0;
  private lastKey = "";
  private pendingKey = "";
  private pending: Record<string, unknown> | null = null;
  private enabled = true;

  constructor(
    private readonly clientId: string,
    private readonly paths: string[] = defaultIpcPaths(),
  ) {}

  // settings toggle: turning it off clears what discord shows; turning it on resumes on the next player update
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.lastKey = "";
    if (!enabled && this.ready) {
      this.pending = null;
      this.pendingKey = "none";
      this.flush();
    }
  }

  update(state: TouchBarStatePayload, now = Date.now()): void {
    if (!this.clientId || !this.enabled) return;
    const activity = buildActivity(state, now);
    // renderer sends every 250 ms; only talk to discord on track/status change or a seek (>2 s drift)
    const start = (activity?.timestamps as { start: number } | undefined)?.start ?? 0;
    const key = activity ? `${state.track?.id}|${state.status}|${Math.round(start / 2000)}` : "none";
    if (this.ready && key === this.lastKey) return;
    this.pending = activity;
    this.pendingKey = key;
    if (this.ready) this.flush();
    else this.connect(0); // no-op while handshaking or waiting out RETRY_MS
  }

  destroy(): void {
    this.sock?.destroy();
    this.sock = null;
    this.ready = false;
  }

  private connect(index: number): void {
    if (this.sock || Date.now() < this.retryAt) return;
    if (index >= this.paths.length) {
      this.retryAt = Date.now() + RETRY_MS; // discord not running
      return;
    }
    const sock = net.createConnection(this.paths[index]);
    this.sock = sock;
    let opened = false;
    sock.once("connect", () => {
      opened = true;
      sock.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
    sock.on("data", (chunk) => this.onData(chunk));
    sock.on("error", () => {});
    sock.once("close", () => {
      this.sock = null;
      this.ready = false;
      this.inbox = Buffer.alloc(0);
      if (!opened) this.connect(index + 1);
      else this.retryAt = Date.now() + RETRY_MS;
    });
  }

  private onData(chunk: Buffer): void {
    this.inbox = Buffer.concat([this.inbox, chunk]);
    while (this.inbox.length >= 8) {
      const op = this.inbox.readInt32LE(0);
      const len = this.inbox.readInt32LE(4);
      if (this.inbox.length < 8 + len) return;
      const body = this.inbox.subarray(8, 8 + len);
      this.inbox = this.inbox.subarray(8 + len);
      let msg: { evt?: string } = {};
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {}
      if (op === OP_PING) this.sock?.write(encodeFrame(OP_PONG, msg));
      else if (op === OP_CLOSE) this.sock?.destroy();
      else if (op === OP_FRAME && msg.evt === "READY") {
        this.ready = true;
        this.flush();
      }
    }
  }

  private flush(): void {
    this.lastKey = this.pendingKey;
    this.sock?.write(
      encodeFrame(OP_FRAME, {
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid, activity: this.pending },
        nonce: randomUUID(),
      }),
    );
  }
}
