import { describe, expect, it } from "vitest";
import { extractVideoFrameBlobs } from "./videoFrameExtraction";
import type { VideoFrameExtractionDependencies } from "./videoFrameExtraction";
import { MAX_FRAME_BYTES, MAX_TOTAL_BYTES } from "./gifMakerLogic";

type ListenerEntry = { listener: EventListener; once: boolean };

class FakeVideo {
  readyState = 0;
  preload = "";
  muted = false;
  playsInline = false;
  src = "";
  paused = true;
  private _currentTime = 0;
  removeAttributeCalls = 0;
  loadCalls = 0;
  pauseCalls = 0;
  onCurrentTime: (() => void) | null = null;
  private readonly listeners = new Map<string, ListenerEntry[]>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    const entries = this.listeners.get(type) ?? [];
    entries.push({ listener: callback, once: typeof options === "object" && options.once === true });
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const entries = this.listeners.get(type);
    if (!entries) return;
    this.listeners.set(type, entries.filter((entry) => entry.listener !== listener));
  }

  emit(type: string) {
    const entries = [...(this.listeners.get(type) ?? [])];
    entries.forEach((entry) => {
      if (entry.once) this.removeEventListener(type, entry.listener);
      entry.listener(new Event(type));
    });
  }

  removeAttribute(name: string) {
    if (name === "src") {
      this.removeAttributeCalls += 1;
      this.src = "";
    }
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  load() {
    this.loadCalls += 1;
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value: number) {
    this._currentTime = value;
    this.onCurrentTime?.();
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  toBlobCallback: BlobCallback | null = null;
  onToBlob: (() => void) | null = null;
  private readonly context = {} as CanvasRenderingContext2D;

  getContext(_contextId: "2d") {
    return this.context;
  }

  toBlob(callback: BlobCallback) {
    this.toBlobCallback = callback;
    this.onToBlob?.();
  }
}

function setup() {
  const video = new FakeVideo();
  const canvas = new FakeCanvas();
  const revokedUrls: string[] = [];
  let createdUrls = 0;
  const dependencies: VideoFrameExtractionDependencies = {
    createVideo: () => video as unknown as HTMLVideoElement,
    createCanvas: () => canvas as unknown as HTMLCanvasElement,
    drawFrame: () => undefined,
    createObjectURL: () => "blob:frame-" + ++createdUrls,
    revokeObjectURL: (url) => revokedUrls.push(url),
  };
  const plan = { times: [0], durationMs: 100 };
  const crop = { x: 0, y: 0, width: 2, height: 1 };
  const outputSize = { width: 2, height: 1 };
  return { video, canvas, dependencies, plan, crop, outputSize, revokedUrls };
}

function blobWithSize(size: number): Blob {
  const blob = new Blob(["frame"], { type: "image/png" });
  Object.defineProperty(blob, "size", { value: size });
  return blob;
}

function extract(
  setupState: ReturnType<typeof setup>,
  controller: AbortController,
) {
  return extractVideoFrameBlobs(
    { previewUrl: "blob:video", name: "sample.mp4" },
    setupState.plan,
    setupState.crop,
    0,
    setupState.outputSize,
    () => undefined,
    setupState.dependencies,
    controller.signal,
  );
}

describe("video frame extraction lifecycle", () => {
  it("carries the planned GIF duration into every extracted frame", async () => {
    const state = setup();
    const controller = new AbortController();
    state.video.onCurrentTime = () => state.video.emit("seeked");
    state.canvas.onToBlob = () => state.canvas.toBlobCallback?.(new Blob(["frame"], { type: "image/png" }));
    const pending = extract(state, controller);
    state.video.readyState = 1;
    state.video.emit("loadedmetadata");

    const frames = await pending;

    expect(frames).toHaveLength(1);
    expect(frames[0]?.durationMs).toBe(state.plan.durationMs);
    expect(state.video.src).toBe("");
    expect(state.canvas.width).toBe(0);
  });

  it("cancels while waiting for loadedmetadata and releases the video resource", async () => {
    const state = setup();
    const controller = new AbortController();
    const pending = extract(state, controller);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.video.removeAttributeCalls).toBe(1);
    expect(state.video.src).toBe("");
    expect(state.video.pauseCalls).toBe(1);
    expect(state.video.loadCalls).toBe(1);
    expect(state.revokedUrls).toEqual([]);
  });

  it("cancels from the seeked stage and clears the canvas and video", async () => {
    const state = setup();
    const controller = new AbortController();
    state.video.onCurrentTime = () => state.video.emit("seeked");
    state.video.addEventListener("seeked", () => controller.abort());
    const pending = extract(state, controller);
    state.video.readyState = 1;
    state.video.emit("loadedmetadata");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(state.canvas.width).toBe(0);
    expect(state.canvas.height).toBe(0);
    expect(state.video.src).toBe("");
    expect(state.revokedUrls).toEqual([]);
  });

  it("cancels while toBlob is pending and clears the canvas and video", async () => {
    const state = setup();
    const controller = new AbortController();
    state.video.onCurrentTime = () => state.video.emit("seeked");
    state.canvas.onToBlob = () => controller.abort();
    const pending = extract(state, controller);
    state.video.readyState = 1;
    state.video.emit("loadedmetadata");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(state.canvas.width).toBe(0);
    expect(state.canvas.height).toBe(0);
    expect(state.video.src).toBe("");
    expect(state.revokedUrls).toEqual([]);
  });

  it("cleans completed URLs and media resources when seeking fails", async () => {
    const state = setup();
    const controller = new AbortController();
    state.plan.times.push(1);
    state.video.onCurrentTime = () => {
      if (state.video.currentTime === 0) state.video.emit("seeked");
      else state.video.emit("error");
    };
    state.canvas.onToBlob = () => state.canvas.toBlobCallback?.(new Blob(["frame"], { type: "image/png" }));
    const pending = extract(state, controller);
    state.video.readyState = 1;
    state.video.emit("loadedmetadata");

    await expect(pending).rejects.toThrow("视频帧读取失败");
    expect(state.revokedUrls).toEqual(["blob:frame-1"]);
    expect(state.canvas.width).toBe(0);
    expect(state.canvas.height).toBe(0);
    expect(state.video.src).toBe("");
  });

  it("cleans media resources when canvas encoding returns a null Blob", async () => {
    const state = setup();
    const controller = new AbortController();
    state.plan.times.push(1);
    let encodedFrames = 0;
    state.video.onCurrentTime = () => state.video.emit("seeked");
    state.canvas.onToBlob = () => {
      encodedFrames += 1;
      state.canvas.toBlobCallback?.(encodedFrames === 1 ? new Blob(["frame"], { type: "image/png" }) : null);
    };
    const pending = extract(state, controller);
    state.video.readyState = 1;
    state.video.emit("loadedmetadata");

    await expect(pending).rejects.toThrow("无法生成视频帧");
    expect(state.revokedUrls).toEqual(["blob:frame-1"]);
    expect(state.canvas.width).toBe(0);
    expect(state.canvas.height).toBe(0);
    expect(state.video.src).toBe("");
  });

  it("enforces the 200-frame extraction limit before allocating media", async () => {
    const state = setup();
    const pending = extract({
      ...state,
      plan: { times: Array.from({ length: 201 }, () => 0), durationMs: 100 },
    }, new AbortController());

    await expect(pending).rejects.toThrow("1 到 200");
    expect(state.video.src).toBe("");
  });

  it("accepts one 4K frame but rejects an 8K canvas before allocating media", async () => {
    const fourK = setup();
    fourK.outputSize = { width: 3840, height: 2160 };
    fourK.video.onCurrentTime = () => fourK.video.emit("seeked");
    fourK.canvas.onToBlob = () => fourK.canvas.toBlobCallback?.(new Blob(["frame"], { type: "image/png" }));
    const fourKPending = extract(fourK, new AbortController());
    fourK.video.readyState = 1;
    fourK.video.emit("loadedmetadata");
    await expect(fourKPending).resolves.toHaveLength(1);

    const eightK = setup();
    eightK.outputSize = { width: 7680, height: 4320 };
    await expect(extract(eightK, new AbortController())).rejects.toThrow("1–4096");
    expect(eightK.video.src).toBe("");
  });

  it("supports the 200-frame plan without exceeding the pixel budget", async () => {
    const state = setup();
    state.plan.times = Array.from({ length: 200 }, (_, index) => index);
    state.video.onCurrentTime = () => state.video.emit("seeked");
    state.canvas.onToBlob = () => state.canvas.toBlobCallback?.(new Blob(["frame"], { type: "image/png" }));
    const pending = extract(state, new AbortController());
    state.video.readyState = 1;
    state.video.emit("loadedmetadata");

    await expect(pending).resolves.toHaveLength(200);
    expect(state.revokedUrls).toEqual([]);
  });

  it("rejects an oversized frame before creating an object URL", async () => {
    const state = setup();
    const controller = new AbortController();
    state.video.onCurrentTime = () => state.video.emit("seeked");
    state.canvas.onToBlob = () => state.canvas.toBlobCallback?.(blobWithSize(MAX_FRAME_BYTES + 1));
    const pending = extract(state, controller);
    state.video.readyState = 1;
    state.video.emit("loadedmetadata");

    await expect(pending).rejects.toThrow("32 MiB");
    expect(state.revokedUrls).toEqual([]);
  });

  it("rejects cumulative frame bytes and releases every earlier object URL", async () => {
    const state = setup();
    state.plan.times = Array.from({ length: 5 }, (_, index) => index);
    state.video.onCurrentTime = () => state.video.emit("seeked");
    state.canvas.onToBlob = () => state.canvas.toBlobCallback?.(blobWithSize(MAX_FRAME_BYTES));
    const pending = extract(state, new AbortController());
    state.video.readyState = 1;
    state.video.emit("loadedmetadata");

    await expect(pending).rejects.toThrow(`${MAX_TOTAL_BYTES / (1024 * 1024)} MiB`);
    expect(state.revokedUrls).toEqual(["blob:frame-1", "blob:frame-2", "blob:frame-3", "blob:frame-4"]);
  });

  it("releases completed frame URLs when cancellation arrives between frames", async () => {
    const state = setup();
    state.plan.times.push(1);
    const controller = new AbortController();
    let encodedFrames = 0;
    state.video.onCurrentTime = () => state.video.emit("seeked");
    state.canvas.onToBlob = () => {
      encodedFrames += 1;
      state.canvas.toBlobCallback?.(new Blob(["frame"], { type: "image/png" }));
      if (encodedFrames === 1) controller.abort();
    };
    const pending = extract(state, controller);
    state.video.readyState = 1;
    state.video.emit("loadedmetadata");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.revokedUrls).toEqual(["blob:frame-1"]);
  });
});
