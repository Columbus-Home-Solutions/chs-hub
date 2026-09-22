import { describe, it, expect } from "vitest";
import {
  parseSignatureMeta,
  priorBoldSignEnvelopeNeedsRevoke,
} from "../src/lib/estimate-contract-document.js";

describe("priorBoldSignEnvelopeNeedsRevoke", () => {
  it("revokes a viewed envelope that still has a BoldSign document id", () => {
    const meta = parseSignatureMeta(
      JSON.stringify({
        template_type: "service_agreement",
        signature_status: "viewed",
        boldsign_document_id: "17ea82fb-6e93-413e-93c5-6898643870a1",
        signer_email: "wright.realtor.cindee@gmail.com",
        signer_name: "Cindee Wright",
      }),
    );
    expect(priorBoldSignEnvelopeNeedsRevoke(meta)).toBe(true);
  });

  it("revokes sent and pending envelopes", () => {
    expect(
      priorBoldSignEnvelopeNeedsRevoke({
        boldsign_document_id: "abc",
        signature_status: "sent",
      }),
    ).toBe(true);
    expect(
      priorBoldSignEnvelopeNeedsRevoke({
        boldsign_document_id: "abc",
        signature_status: "pending",
      }),
    ).toBe(true);
  });

  it("does not revoke completed, revoked, declined, or expired envelopes", () => {
    for (const status of ["completed", "revoked", "declined", "expired"]) {
      expect(
        priorBoldSignEnvelopeNeedsRevoke({
          boldsign_document_id: "abc",
          signature_status: status,
        }),
      ).toBe(false);
    }
  });

  it("does not revoke when no BoldSign document id exists", () => {
    expect(priorBoldSignEnvelopeNeedsRevoke({ signature_status: "viewed" })).toBe(false);
    expect(priorBoldSignEnvelopeNeedsRevoke({})).toBe(false);
  });
});
