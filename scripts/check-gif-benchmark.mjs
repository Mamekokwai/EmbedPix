import fs from "node:fs";

const directory = process.argv[2] ?? "benchmarks/gif/e3";
const baseline = JSON.parse(fs.readFileSync(`${directory}/baseline.json`, "utf8"));
const thresholds = JSON.parse(fs.readFileSync(`${directory}/thresholds.json`, "utf8"));
const failures = [];

if (baseline.failureRate > thresholds.maxFailureRate) {
  failures.push(`failureRate ${baseline.failureRate} > ${thresholds.maxFailureRate}`);
}
for (const sample of baseline.samples) {
  const limit = thresholds.cases[sample.name];
  if (!limit) {
    failures.push(`${sample.name}: missing threshold`);
    continue;
  }
  for (const [field, label] of [["elapsedMs", "elapsedMs"], ["peakMemoryBytes", "peakMemoryBytes"], ["outputBytes", "outputBytes"], ["peakDiskBytes", "peakDiskBytes"]]) {
    if (sample[field] > limit[`max${label[0].toUpperCase()}${label.slice(1)}`]) {
      failures.push(`${sample.name}: ${field} ${sample[field]} exceeds threshold`);
    }
  }
}
if (baseline.samples.length !== baseline.caseCount) failures.push("sample count does not match case count");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`GIF benchmark thresholds passed: ${baseline.samples.length}/${baseline.caseCount} cases`);
