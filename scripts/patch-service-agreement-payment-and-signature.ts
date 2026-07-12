/**
 * Fixes service-agreement.docx:
 *  1. Payment schedule table — merge tags for milestone amounts + due dates
 *  2. Signature table — BoldSign tags in correct client cells (via shared runtime patcher)
 *
 * Run after prep-templates.ts:
 *   npx tsx scripts/prep-templates.ts
 *   npx tsx scripts/patch-service-agreement-payment-and-signature.ts
 */

import * as fs from "fs";
import * as path from "path";
import { ensureServiceAgreementTemplate } from "../src/lib/service-agreement-template.ts";

const PREPPED = path.join(import.meta.dirname, "../src/templates/prepped/service-agreement.docx");

function main() {
  const buf = fs.readFileSync(PREPPED);
  console.log("Patching service-agreement.docx …");
  const patched = ensureServiceAgreementTemplate(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  fs.writeFileSync(PREPPED, Buffer.from(patched));
  console.log("Done.");
}

main();
