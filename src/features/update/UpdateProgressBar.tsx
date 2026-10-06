export interface UpdateProgressModel {
  percent: number | null;
  indeterminate: boolean;
  label: string;
  valueText: string | null;
}

export default function UpdateProgressBar({
  progress,
  className,
}: {
  progress: UpdateProgressModel;
  className?: string;
}) {
  const resolvedPercent = progress.percent ?? 0;
  return (
    <div className={["update-progress", className].filter(Boolean).join(" ")} aria-label={progress.label}>
      <div className="update-progress-label">
        <span>{progress.label}</span>
        {progress.valueText ? <strong>{progress.valueText}</strong> : null}
      </div>
      <div
        className="update-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.indeterminate ? undefined : resolvedPercent}
        aria-valuetext={progress.valueText ?? progress.label}
      >
        {progress.indeterminate ? (
          <span className="update-progress-indeterminate" />
        ) : (
          <span className="update-progress-value" style={{ width: `${resolvedPercent}%` }} />
        )}
      </div>
    </div>
  );
}
