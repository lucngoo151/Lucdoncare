// @vitest-environment node
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildActivity, DiscordPresence, encodeFrame } from "./discord-presence";
import type { TouchBarStatePayload } from "./touchbar";

const state = (patch: Partial<TouchBarStatePayload> = {}): TouchBarStatePayload => ({
  status: "playing",
  track: { id: "t1", title: "pyro - slowed", artist: "Artist", album: "Album", cover: "https://i.ytimg.com/vi/x/hq.jpg", durationMs: 180_000 },
  positionMs: 30_000,
  durationMs: 180_000,
  volume: 1,
  isLiked: false,
  shuffle: false,
  repeat: "off",
  ...patch,
});

describe("discord presence payload", () => {
  it("frames are int32le opcode + int32le length + json", () => {
    const frame = encodeFrame(1, { a: 1 });
    expect(frame.readInt32LE(0)).toBe(1);
    expect(frame.readInt32LE(4)).toBe(7);
    expect(frame.subarray(8).toString()).toBe('{"a":1}');
  });

  it("shows a listening activity with a progress bar while playing", () => {
    const activity = buildActivity(state(), 1_000_000) as any;
    expect(activity.type).toBe(2);
    expect(activity.details).toBe("pyro - slowed");
    expect(activity.state).toBe("Artist");
    expect(activity.timestamps).toEqual({ start: 970_000, end: 1_150_000 });
    expect(activity.assets.large_image).toBe("https://i.ytimg.com/vi/x/hq.jpg");
  });

  it("clears on pause and drops non-https covers", () => {
    expect(buildActivity(state({ status: "paused" }), 0)).toBeNull();
    const local = buildActivity(state({ track: { title: "X", artist: "", cover: "blob:abc" } }), 0) as any;
    expect(local.assets).toBeUndefined();
    expect(local.details.length).toBe(2); // padded to discord's 2-char minimum
  });
});

describe("DiscordPresence over a fake discord socket", () => {
  let server: net.Server | null = null;
  afterEach(() => server?.close());

  it("handshakes, waits for READY, and only resends on real changes", async () => {
    const pipe =
      process.platform === "win32"
        ? `\\\\?\\pipe\\liner-discord-test-${process.pid}`
        : path.join(os.tmpdir(), `liner-discord-test-${process.pid}`);
    const frames: any[] = [];
    server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4)) {
          const len = buf.readInt32LE(4);
          const msg = { op: buf.readInt32LE(0), body: JSON.parse(buf.subarray(8, 8 + len).toString()) };
          buf = buf.subarray(8 + len);
          frames.push(msg);
          if (msg.op === 0) sock.write(encodeFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
        }
      });
    });
    await new Promise<void>((r) => server!.listen(pipe, r));

    // first path does not exist: the client must fall through to the next one
    const presence = new DiscordPresence("123", [`${pipe}-missing`, pipe]);
    presence.update(state(), 1_000_000);
    await vi.waitFor(() => expect(frames.filter((f) => f.op === 1)).toHaveLength(1));
    expect(frames[0].body).toEqual({ v: 1, client_id: "123" });

    // the renderer sends every 250 ms: same track, normal progress = nothing new for discord
    presence.update(state({ positionMs: 30_250 }), 1_000_250);
    presence.update(state({ positionMs: 30_500 }), 1_000_500);
    presence.update(state({ status: "paused" }), 1_000_750);
    await vi.waitFor(() => expect(frames.filter((f) => f.op === 1)).toHaveLength(2));
    const [first, second] = frames.filter((f) => f.op === 1).map((f) => f.body);
    expect(first.cmd).toBe("SET_ACTIVITY");
    expect(first.args.activity.details).toBe("pyro - slowed");
    expect(second.args.activity).toBeNull();
    presence.destroy();
  });
});
