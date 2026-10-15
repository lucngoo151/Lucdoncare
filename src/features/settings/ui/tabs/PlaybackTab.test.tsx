import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";

// the player feature index pulls lottie/canvas ui that jsdom cannot load; the tab only needs the store
vi.mock("@/features/player", async () => ({
  usePlayerStore: (await import("@/features/player/store/playerStore")).usePlayerStore,
}));
vi.mock("@/languages", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { PlaybackTab } from "./PlaybackTab";
import { usePlayerStore } from "@/features/player/store/playerStore";

describe("PlaybackTab — Discord Rich Presence", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    usePlayerStore.setState({ discordPresence: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the switch and turns the setting off and back on", async () => {
    await act(async () => root.render(<PlaybackTab />));
    const title = [...container.querySelectorAll("*")].find(
      (el) => el.childElementCount === 0 && el.textContent === "settings.discord_presence.title",
    );
    expect(title).toBeTruthy();

    let row: Element | null | undefined = title;
    while (row && !row.querySelector("button")) row = row.parentElement;
    const toggle = row!.querySelector("button")!;

    await act(async () => toggle.click());
    expect(usePlayerStore.getState().discordPresence).toBe(false);
    await act(async () => toggle.click());
    expect(usePlayerStore.getState().discordPresence).toBe(true);
  });
});
