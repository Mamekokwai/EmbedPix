import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVideoMetadata, VIDEO_METADATA_TIMEOUT_MS } from "./videoMetadata";

class FakeVideo {
  preload = "";
  muted = false;
  playsInline = false;
  duration = 2.5;
  videoWidth = 640;
  videoHeight = 360;
  failSourceAssignment = false;
  private _src = "";
  removeAttributeCalls = 0;
  loadCalls = 0;
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    const entries = this.listeners.get(type) ?? new Set<EventListener>();
    entries.add(callback);
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.get(type)?.delete(callback);
  }

  emit(type: string) {
    this.listeners.get(type)?.forEach((listener) => listener(new Event(type)));
  }

  removeAttribute(name: string) {
    if (name === "src") {
      this.removeAttributeCalls += 1;
      this.src = "";
    }
  }

  load() {
    this.loadCalls += 1;
  }

  get src() {
    return this._src;
  }

  set src(value: string) {
    if (this.failSourceAssignment && value) throw new Error("source assignment failed");
    this._src = value;
  }
}

afterEach(() => vi.useRealTimers());

describe("video metadata lifecycle", () => {
  it("cleans listeners and media state after metadata resolves", async () => {
    const video = new FakeVideo();
    const pending = loadVideoMetadata("blob:video", undefined, () => video as unknown as HTMLVideoElement);
    video.emit("loadedmetadata");

    await expect(pending).resolves.toEqual({ width: 640, height: 360, duration: 2.5 });
    expect(video.src).toBe("");
    expect(video.removeAttributeCalls).toBe(1);
    expect(video.loadCalls).toBe(1);
  });

  it("cancels and cleans media state", async () => {
    const video = new FakeVideo();
    const controller = new AbortController();
    const pending = loadVideoMetadata("blob:video", controller.signal, () => video as unknown as HTMLVideoElement);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(video.src).toBe("");
    expect(video.loadCalls).toBe(1);
  });

  it("fails and cleans media state when metadata times out", async () => {
    vi.useFakeTimers();
    const video = new FakeVideo();
    const pending = loadVideoMetadata("blob:video", undefined, () => video as unknown as HTMLVideoElement);
    const rejection = expect(pending).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(VIDEO_METADATA_TIMEOUT_MS);

    await rejection;
    expect(video.src).toBe("");
    expect(video.loadCalls).toBe(1);
  });

  it("explains the supported video formats when decoding fails", async () => {
    const video = new FakeVideo();
    const pending = loadVideoMetadata("blob:video", undefined, () => video as unknown as HTMLVideoElement);
    video.emit("error");

    await expect(pending).rejects.toThrow("MP4、WebM 或 OGG");
    expect(video.src).toBe("");
    expect(video.loadCalls).toBe(1);
  });

  it("cleans media state immediately when source binding fails", async () => {
    const video = new FakeVideo();
    video.failSourceAssignment = true;

    await expect(loadVideoMetadata("blob:video", undefined, () => video as unknown as HTMLVideoElement)).rejects.toThrow("source assignment failed");
    expect(video.src).toBe("");
    expect(video.removeAttributeCalls).toBe(1);
    expect(video.loadCalls).toBe(1);
  });
});
