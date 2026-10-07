import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Film,
  Info,
  Images,
  Menu,
  Minimize2,
  Settings2,
} from "lucide-react";
import AppTitleBar from "./AppTitleBar";
import ImageConverter from "../features/image-converter/ImageConverter";
import AboutView from "../features/about/AboutView";
import SettingsView from "../features/settings/SettingsView";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import type { UpdateCheckState } from "./hooks/useUpdateCheck";
import {
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  resolveTheme,
  saveAppPreferences,
  type AppPreferences,
  type SidebarMode,
  type ThemeMode,
} from "../platform/preferences/appPreferences";
import { applyThemeColors } from "../shared/theme/deriveTheme";

type AppView = "converter" | "compression" | "gif" | "settings" | "about";

// 预览态只装主题三个字段：设置页草稿里的主题改动先在这里生效；落盘仍只认已提交的 preferences。
type ThemePreview = Pick<AppPreferences, "themeMode" | "colorSchemeLight" | "colorSchemeDark">;

const LazyImageCompressionView = lazy(() => import("../features/image-compression/ImageCompressionView"));
const LazyGifMakerView = lazy(() => import("../features/gif-maker/GifMakerView"));

const NAV_ITEMS: ReadonlyArray<{ id: AppView; label: string; hint: string; icon: typeof Images }> = [
  { id: "converter", label: "图片转换", hint: "导入、调整并导出", icon: Images },
  { id: "compression", label: "图片压缩", hint: "批量降低图片体积", icon: Minimize2 },
  { id: "gif", label: "GIF 制作", hint: "图片序列制作动画", icon: Film },
  { id: "settings", label: "设置", hint: "外观与默认参数", icon: Settings2 },
  { id: "about", label: "关于", hint: "版本与项目信息", icon: Info },
];

function toUpdateViewProps(state: UpdateCheckState) {
  const info = "info" in state ? state.info : null;
  return {
    currentVersion: state.currentVersion,
    latestVersion: info?.latestVersion,
    status: state.status === "checking"
      ? "checking" as const
      : state.status === "downloading"
        ? "downloading" as const
        : state.status === "downloaded"
          ? "downloaded" as const
      : state.status === "installing"
        ? "installing" as const
      : state.status === "cancelled"
        ? "cancelled" as const
      : state.status === "error"
        ? "error" as const
        : info?.updateAvailable
          ? "available" as const
          : state.status === "complete"
            ? "up-to-date" as const
            : "idle" as const,
    releaseNotes: info?.releaseNotes ?? undefined,
    releaseUrl: info?.releaseUrl,
    assetAvailable: Boolean(info?.assetDownloadUrl && info.assetSha256),
    errorStage: state.status === "error" ? state.errorStage : undefined,
    downloadedBytes: "downloadedBytes" in state ? state.downloadedBytes : null,
    totalBytes: "totalBytes" in state ? state.totalBytes : null,
    errorMessage: state.status === "error" ? state.error : undefined,
    installHealthMessage: info?.installHealth?.message,
  };
}

function getPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export default function AppShell() {
  const [view, setView] = useState<AppView>("converter");
  const [mountedViews, setMountedViews] = useState(() => ({ gif: false, compression: false }));
  const [preferences, setPreferences] = useState<AppPreferences>(() => loadAppPreferences());
  // 主题预览：设置页在草稿里改主题时上报，只影响这三个字段；保存/取消由设置页清成 null。
  const [themePreview, setThemePreview] = useState<ThemePreview | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => preferences.sidebarMode);
  const [prefersDark, setPrefersDark] = useState(getPrefersDark);
  const {
    state: updateState,
    runCheck: checkForUpdates,
    runDownload: downloadUpdate,
    runCancelDownload: cancelDownload,
    runInstall: installUpdate,
    openReleasePage,
  } = useUpdateCheck();
  // 预览优先、否则用已提交值——两者都走同一个 resolveTheme，跟随系统不会另立规则。
  const previewThemeMode = themePreview?.themeMode ?? preferences.themeMode;
  const previewColorSchemeLight = themePreview?.colorSchemeLight ?? preferences.colorSchemeLight;
  const previewColorSchemeDark = themePreview?.colorSchemeDark ?? preferences.colorSchemeDark;
  const activeTheme = useMemo(() => resolveTheme(previewThemeMode, prefersDark), [previewThemeMode, prefersDark]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setPrefersDark(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme;
    // 配色方案按当前明暗各取一套；派生结果写成内联变量，覆盖 tokens.css 的静态色值。
    applyThemeColors(activeTheme, activeTheme === "dark" ? previewColorSchemeDark : previewColorSchemeLight);
    // 依赖只收影响主题的字段：设置页里改其它字段不该重跑 deriveTheme、重写全部内联色变量（拖滑杆的掉帧源）。
  }, [activeTheme, previewColorSchemeLight, previewColorSchemeDark]);

  // 落盘必须看整个 preferences——任一字段改动都要写进 localStorage；debounce 把连续输入（敲变量名、拖滑杆）合并成一次写。
  useEffect(() => {
    const timer = window.setTimeout(() => saveAppPreferences(preferences), 250);
    return () => window.clearTimeout(timer);
  }, [preferences]);

  useEffect(() => {
    if (view !== "gif" && view !== "compression") return;
    setMountedViews((current) => current[view] ? current : { ...current, [view]: true });
  }, [view]);

  const updatePreferences = (next: Partial<AppPreferences>) => {
    setPreferences((current) => ({ ...current, ...next }));
  };

  // 稳定引用：设置页的上报 effect 把它列进依赖，identity 一变就会清掉再重报预览。
  const handleThemePreview = useCallback((preview: ThemePreview | null) => setThemePreview(preview), []);

  const toggleSidebarMode = () => {
    setSidebarMode((current) => {
      const next = current === "icon" ? "labeled" : "icon";
      setPreferences((currentPreferences) => ({ ...currentPreferences, sidebarMode: next }));
      return next;
    });
  };

  return (
    <div className="app-frame">
      <AppTitleBar />

      <div className="app-shell">
        <aside className="app-sidebar" aria-label="主导航" data-sidebar-mode={sidebarMode}>
          <div className="sidebar-brand" aria-label="嵌图匠 EmbedPix">
            <img src="/embedpix-icon.png" alt="" aria-hidden="true" />
            <div className="sidebar-brand-copy">
              <strong>嵌图匠</strong>
              <span>EmbedPix</span>
            </div>
          </div>

          <nav className="sidebar-nav">
            <p className="sidebar-section-label">工作区</p>
            {NAV_ITEMS.map(({ id, label, hint, icon: Icon }) => {
              const active = view === id;
              return (
                <button
                  key={id}
                  className={`sidebar-nav-item${active ? " sidebar-nav-item-active" : ""}`}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  aria-label={label}
                  onClick={() => setView(id)}
                  title={`${label} · ${hint}`}
                >
                  <Icon size={18} strokeWidth={2.1} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>

          <div className="sidebar-footer">
            <button
              type="button"
              className={`sidebar-mode-toggle${sidebarMode === "labeled" ? " sidebar-mode-toggle-active" : ""}`}
              aria-label={sidebarMode === "icon" ? "显示导航文字" : "隐藏导航文字"}
              aria-pressed={sidebarMode === "labeled"}
              onClick={toggleSidebarMode}
              title="切换导航标签"
            >
              <Menu size={16} strokeWidth={1.9} aria-hidden="true" />
            </button>
          </div>
        </aside>

        <main className={`app-main${view === "gif" ? " app-main-gif" : ""}${view === "compression" ? " app-main-compression" : ""}`}>
          <div className="app-kept-view" hidden={view !== "converter"}>
            <ImageConverter
              active={view === "converter"}
              defaultOutputFormat={preferences.defaultOutputFormat}
              defaultJpegQuality={preferences.defaultJpegQuality}
              defaultBitDepth={preferences.defaultBitDepth}
              defaultByteOrder={preferences.defaultByteOrder}
              defaultChannelOrder={preferences.defaultChannelOrder}
              defaultRowOrder={preferences.defaultRowOrder}
              defaultRowAlignment={preferences.defaultRowAlignment}
              defaultCArrayName={preferences.defaultCArrayName}
              defaultBackgroundColor={preferences.defaultBackgroundColor}
              defaultKeepAspectRatio={preferences.keepAspectRatio}
            />
          </div>
          <div className="app-kept-view app-kept-gif" hidden={view !== "gif"}>
            <Suspense fallback={<div className="app-view-loading" role="status">正在加载 GIF 工作台…</div>}>
              {mountedViews.gif ? <LazyGifMakerView active={view === "gif"} /> : null}
            </Suspense>
          </div>
          <div className="app-kept-view app-kept-compression" hidden={view !== "compression"}>
            <Suspense fallback={<div className="app-view-loading" role="status">正在加载压缩工作台…</div>}>
              {mountedViews.compression ? <LazyImageCompressionView active={view === "compression"} /> : null}
            </Suspense>
          </div>
          {view === "settings" ? (
            <SettingsView
              preferences={preferences}
              onChange={updatePreferences}
              onThemePreview={handleThemePreview}
              onReset={() => {
                setPreferences(DEFAULT_APP_PREFERENCES);
                setSidebarMode(DEFAULT_APP_PREFERENCES.sidebarMode);
              }}
            />
          ) : view === "about" ? (
            <AboutView
              {...toUpdateViewProps(updateState)}
              onCheckForUpdates={async () => { await checkForUpdates(); }}
              onDownloadUpdate={async () => { await downloadUpdate(); }}
              onCancelDownload={async () => { await cancelDownload(); }}
              onInstallUpdate={async () => { await installUpdate(); }}
              onOpenReleasePage={() => openReleasePage(updateState.info?.releaseUrl)}
            />
          ) : (
            null
          )}
        </main>
      </div>
    </div>
  );
}

export type { AppPreferences, ThemeMode };
