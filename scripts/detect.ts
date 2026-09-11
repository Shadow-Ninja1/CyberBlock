/** CLI: run the detector against a tarball and print the grade. `npm run detect <path>` */
import { analyzeFile } from "../lib/detector";
import { VULN_CLASS_LABEL } from "../lib/types";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run detect <path-to-tarball>");
  process.exit(1);
}

const r = analyzeFile(path);
console.log(`artifact   ${r.artifactHash}`);
console.log(`detector   ${r.detectorVersion}  (${r.detectorHash.slice(0, 18)}…)`);
console.log(`severity   ${r.severity}/100`);
console.log(`class      ${VULN_CLASS_LABEL[r.vulnClass]}`);
console.log(`signals    ${r.signals.length}`);
for (const s of r.signals) {
  console.log(`  [${String(s.weight).padStart(2)}] ${s.rule.padEnd(34)} ${s.file}`);
  console.log(`       ${s.evidence}`);
}
