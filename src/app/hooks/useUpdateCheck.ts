import { useCallback, useState } from "react";
import {
  checkForUpdates,
  CURRENT_VERSION,
  type UpdateInfo,
} from "../../platform/update/updateGateway";

export type UpdateCheckState =
  | { status: "idle"; currentVersion: string; info: null; error: null }
  | { status: "checking"; currentVersion: string; info: null; error: null }
  | { status: "complete"; currentVersion: string; info: UpdateInfo; error: null }
  | { status: "error"; currentVersion: string; info: null; error: string };

export function useUpdateCheck() {
  const [state, setState] = useState<UpdateCheckState>({
    status: "idle",
    currentVersion: CURRENT_VERSION,
    info: null,
    error: null,
  });

  const runCheck = useCallback(async () => {
    setState((current) => ({
      status: "checking",
      currentVersion: current.currentVersion,
      info: null,
      error: null,
    }));
    try {
      const info = await checkForUpdates();
      setState({ status: "complete", currentVersion: info.currentVersion, info, error: null });
    } catch (error) {
      setState((current) => ({
        status: "error",
        currentVersion: current.currentVersion,
        info: null,
        error: error instanceof Error ? error.message : "检查更新失败，请稍后重试。",
      }));
    }
  }, []);

  return { state, runCheck };
}
