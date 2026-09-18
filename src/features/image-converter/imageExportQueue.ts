export interface ExportQueueProgress<T> {
  item: T;
  index: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface ExportQueueFailure<T> {
  item: T;
  error: unknown;
}

export interface ExportQueueResult<T> {
  total: number;
  succeeded: T[];
  failed: Array<ExportQueueFailure<T>>;
  skipped: T[];
  cancelled: boolean;
}

export interface ExportQueueOptions<T> {
  shouldCancel?: () => boolean;
  onProgress?: (progress: ExportQueueProgress<T>) => void;
}

export async function runExportQueue<T>(
  items: ReadonlyArray<T>,
  exportItem: (item: T, index: number) => Promise<void>,
  options: ExportQueueOptions<T> = {},
): Promise<ExportQueueResult<T>> {
  const succeeded: T[] = [];
  const failed: Array<ExportQueueFailure<T>> = [];
  const skipped: T[] = [];
  let cancelled = false;

  for (const [index, item] of items.entries()) {
    if (options.shouldCancel?.()) {
      skipped.push(...items.slice(index));
      cancelled = true;
      break;
    }

    options.onProgress?.({
      item,
      index: index + 1,
      total: items.length,
      succeeded: succeeded.length,
      failed: failed.length,
      skipped: skipped.length,
    });
    try {
      await exportItem(item, index);
      succeeded.push(item);
    } catch (error) {
      failed.push({ item, error });
    }
  }

  return { total: items.length, succeeded, failed, skipped, cancelled };
}

export function formatExportQueueProgress(progress: ExportQueueProgress<{ file: { name: string } }>) {
  return `正在导出 ${progress.index}/${progress.total}：${progress.item.file.name} · 成功 ${progress.succeeded} · 失败 ${progress.failed}`;
}

export function formatExportQueueSummary(result: Pick<ExportQueueResult<unknown>, "succeeded" | "failed" | "skipped" | "cancelled">) {
  const prefix = result.cancelled ? "已取消" : "导出完成";
  return `${prefix}：成功 ${result.succeeded.length}，失败 ${result.failed.length}，跳过 ${result.skipped.length}`;
}
