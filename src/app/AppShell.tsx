import { useEffect, useMemo, useState } from "react";
import {
  Info,
  Images,
  Settings2,
} from "lucide-react";
import ImageConverter from "../features/image-converter/ImageConverter";
import AboutView from "../features/about/AboutView";
import SettingsView from "../features/settings/SettingsView";
import {
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  resolveTheme,
  saveAppPreferences,
  type AppPreferences,
  type ThemeMode,
} from "../platform/preferences/appPreferences";

type AppView = "converter" | "settings" | "about";

const NAV_ITEMS: ReadonlyArray<{ id: AppView; label: string; hint: string; icon: typeof Images }> = [
  { id: "converter", label: "图片转换", hint: "导入、调整并导出", icon: Images },
  { id: "settings", label: "设置", hint: "外观与默认参数", icon: Settings2 },
  { id: "about", label: "关于", hint: "版本与项目信息", icon: Info },
];

function getPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export default function AppShell() {
  const [view, setView] = useState<AppView>("converter");
  const [preferences, setPreferences] = useState<AppPreferences>(() => loadAppPreferences());
  const [prefersDark, setPrefersDark] = useState(getPrefersDark);
  const activeTheme = useMemo(() => resolveTheme(preferences.themeMode, prefersDark), [preferences.themeMode, prefersDark]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setPrefersDark(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme;
    saveAppPreferences(preferences);
  }, [activeTheme, preferences]);

  const updatePreferences = (next: Partial<AppPreferences>) => {
    setPreferences((current) => ({ ...current, ...next }));
  };

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="主导航">
        <div className="sidebar-brand">
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
                onClick={() => setView(id)}
                title={hint}
              >
                <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <span className="sidebar-local-status"><span aria-hidden="true" />本地处理</span>
          <span className="sidebar-version">v0.1.0</span>
        </div>
      </aside>

      <main className="app-main">
        {view === "converter" ? (
          <ImageConverter
            defaultOutputFormat={preferences.defaultOutputFormat}
            defaultJpegQuality={preferences.defaultJpegQuality}
            defaultKeepAspectRatio={preferences.keepAspectRatio}
          />
        ) : view === "settings" ? (
          <SettingsView
            preferences={preferences}
            onChange={updatePreferences}
            onReset={() => setPreferences(DEFAULT_APP_PREFERENCES)}
          />
        ) : (
          <AboutView />
        )}
      </main>
    </div>
  );
}

export type { AppPreferences, ThemeMode };
