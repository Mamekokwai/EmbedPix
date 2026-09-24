import fs from "node:fs";

const directory = process.argv[2] ?? "benchmarks/gif/e5";
const report = JSON.parse(fs.readFileSync(`${directory}/quality-report.json`, "utf8"));
const thresholds = JSON.parse(fs.readFileSync(`${directory}/thresholds.json`, "utf8"));
const failures = [];
for (const sample of report.presets) {
  const limit = thresholds.presets[sample.preset];
  if (!limit) {
    failures.push(`${sample.preset}: missing threshold`);
    continue;
  }
  for (const [field, threshold] of [["elapsedMs", "maxElapsedMs"], ["outputBytes", "maxOutputBytes"], ["peakMemoryBytes", "maxPeakMemoryBytes"], ["qualityMaeRgb", "maxQualityMaeRgb"]]) {
    if (sample[field] > limit[threshold]) failures.push(`${sample.preset}: ${field} ${sample[field]} exceeds ${limit[threshold]}`);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`GIF quality thresholds passed: ${report.presets.length} presets`);
