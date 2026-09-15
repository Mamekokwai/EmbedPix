import packageJson from "../../../package.json";

export const CURRENT_VERSION = packageJson.version;
export const RELEASES_API_URL = "https://api.github.com/repos/Mamekokwai/EngiFormat/releases/latest";
export const RELEASES_PAGE_URL = "https://github.com/Mamekokwai/EngiFormat/releases";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string | null;
  releaseDate: string | null;
  releaseUrl: string;
  updateAvailable: boolean;
}

export type UpdateCheckErrorKind = "network" | "server" | "invalid-response";

export class UpdateCheckError extends Error {
  readonly kind: UpdateCheckErrorKind;

  constructor(kind: UpdateCheckErrorKind, message: string) {
    super(message);
    this.name = "UpdateCheckError";
    this.kind = kind;
  }
}

interface ReleaseResponse {
  tag_name?: unknown;
  body?: unknown;
  published_at?: unknown;
  html_url?: unknown;
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

interface ParsedVersion {
  core: number[];
  prerelease: string[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const normalized = normalizeVersion(value);
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/u.exec(normalized);
  if (!match) return null;

  const core = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  if (!core.every(Number.isSafeInteger)) return null;
  return { core, prerelease: match[4]?.split(".") ?? null };
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return 0;

  for (let index = 0; index < 3; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) {
      return leftParts.core[index] > rightParts.core[index] ? 1 : -1;
    }
  }

  if (leftParts.prerelease === null && rightParts.prerelease !== null) return 1;
  if (leftParts.prerelease !== null && rightParts.prerelease === null) return -1;
  if (leftParts.prerelease && rightParts.prerelease) {
    const length = Math.max(leftParts.prerelease.length, rightParts.prerelease.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = leftParts.prerelease[index];
      const rightPart = rightParts.prerelease[index];
      if (leftPart === undefined) return -1;
      if (rightPart === undefined) return 1;
      if (leftPart === rightPart) continue;
      const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
      const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;
      if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
      if (leftNumber !== null) return -1;
      if (rightNumber !== null) return 1;
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function parseReleasePayload(payload: unknown): ReleaseResponse & { tag_name: string } {
  if (!payload || typeof payload !== "object") {
    throw new UpdateCheckError("invalid-response", "更新服务返回了无效数据。");
  }

  const release = payload as ReleaseResponse;
  if (typeof release.tag_name !== "string" || !parseVersion(release.tag_name)) {
    throw new UpdateCheckError("invalid-response", "更新服务没有返回有效版本号。");
  }

  return release as ReleaseResponse & { tag_name: string };
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, dispose: () => globalThis.clearTimeout(timer) };
}

export async function checkForUpdates(
  fetchImpl: typeof fetch = fetch,
  currentVersion = CURRENT_VERSION,
): Promise<UpdateInfo> {
  const timeout = createTimeoutSignal(8_000);
  let response: Response;
  try {
    response = await fetchImpl(RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: timeout.signal,
    });
  } catch {
    throw new UpdateCheckError("network", "无法连接更新服务，请检查网络后重试。");
  } finally {
    timeout.dispose();
  }

  if (!response.ok) {
    throw new UpdateCheckError("server", `更新服务暂时不可用（HTTP ${response.status}）。`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new UpdateCheckError("invalid-response", "无法解析更新服务的返回数据。");
  }

  const release = parseReleasePayload(payload);
  const latestVersion = normalizeVersion(release.tag_name);
  return {
    currentVersion,
    latestVersion,
    releaseNotes: typeof release.body === "string" && release.body.trim() ? release.body.trim() : null,
    releaseDate: typeof release.published_at === "string" ? release.published_at : null,
    releaseUrl: typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/Mamekokwai/EngiFormat/")
      ? release.html_url
      : RELEASES_PAGE_URL,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
  };
}
