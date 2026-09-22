import { describe, expect, it } from "vitest";
import {
  INTAKE_PROMPT,
  buildDialTwiml,
  buildGatherTwiml,
  buildWhisperSayText,
  buildWhisperTwiml,
  capTranscript,
  escapeXmlText,
} from "../src/lib/twilio-voice-twiml.js";

describe("escapeXmlText", () => {
  it("escapes &, <, >, quotes", () => {
    expect(escapeXmlText(`Bob & Sue <roof> "leak"`)).toBe(
      "Bob &amp; Sue &lt;roof&gt; &quot;leak&quot;",
    );
  });
});

describe("capTranscript", () => {
  it("collapses whitespace and caps length", () => {
    expect(capTranscript("  hi   there  ")).toBe("hi there");
    expect(capTranscript("x".repeat(500)).length).toBe(400);
  });
});

describe("buildWhisperSayText", () => {
  it("reads a transcript back verbatim", () => {
    expect(buildWhisperSayText({ transcript: "This is John, roof leak" })).toBe(
      "Caller says: This is John, roof leak",
    );
  });

  it("announces a known name without a prompt delay cue", () => {
    expect(buildWhisperSayText({ name: "Betty Hamilton" })).toBe("Incoming call from Betty Hamilton.");
  });

  it("spells unknown digits when intake did not run (toggle off)", () => {
    expect(buildWhisperSayText({ digits: "5012632050" })).toBe(
      "Incoming call from 5 0 1 2 6 3 2 0 5 0.",
    );
  });

  it("flags silence after the Gather as possible spam", () => {
    expect(buildWhisperSayText({ digits: "5015551212", intakeAttempted: true })).toBe(
      "No name given — possible spam, incoming call from 5 0 1 5 5 5 1 2 1 2.",
    );
  });
});

describe("buildWhisperTwiml", () => {
  it("XML-escapes transcript characters in <Say>", () => {
    const xml = buildWhisperTwiml(buildWhisperSayText({ transcript: "Bob & Sue: roof" }));
    expect(xml).toContain("<Say voice=\"alice\">Caller says: Bob &amp; Sue: roof</Say>");
    expect(xml).not.toMatch(/Caller says: Bob & Sue/);
  });
});

describe("buildDialTwiml", () => {
  it("escapes & in whisper query params so TwiML stays well-formed", () => {
    const whisper = new URL("https://client.homesolutionsar.com/api/webhooks/twilio/call-whisper");
    whisper.searchParams.set("transcript", "Bob & Sue: roof leak");
    whisper.searchParams.set("intake", "1");
    const action = "https://client.homesolutionsar.com/api/webhooks/twilio/call-status?digits=5015551212&client_id=abc";
    const xml = buildDialTwiml({
      forwardNumber: "+15015511814",
      whisperUrl: whisper.toString(),
      actionUrl: action,
    });
    expect(xml).toContain("url=");
    expect(xml).toContain("&amp;");
    // Raw ampersands in attributes would break Twilio's TwiML parse (Round 2 hotfix).
    const urlAttr = xml.match(/url="([^"]+)"/)?.[1] ?? "";
    expect(urlAttr).toContain("&amp;");
    expect(urlAttr).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    const actionAttr = xml.match(/action="([^"]+)"/)?.[1] ?? "";
    expect(actionAttr).toContain("&amp;");
    expect(actionAttr).not.toContain("&client_id=");
  });

  it("omits Dial action when the toggle is off (today's whisper-only flow)", () => {
    const xml = buildDialTwiml({
      forwardNumber: "+15015511814",
      whisperUrl: "https://client.homesolutionsar.com/api/webhooks/twilio/call-whisper?name=Betty",
    });
    expect(xml).not.toContain("action=");
    expect(xml).toContain("<Dial>");
    expect(xml).not.toContain("<Hangup");
  });
});

describe("buildGatherTwiml", () => {
  it("always includes a Redirect fallback so silence still rings through", () => {
    const action =
      "https://client.homesolutionsar.com/api/webhooks/twilio/call-intake?digits=5015551212&transcript=Bob+%26+Sue";
    const xml = buildGatherTwiml({
      prompt: INTAKE_PROMPT,
      actionUrl: action,
      fallbackUrl: action,
    });
    expect(xml).toContain("<Gather");
    expect(xml).toContain("<Say voice=\"alice\">");
    expect(xml).toContain("Thanks for calling Columbus Home Solutions");
    expect(xml).toContain("you&apos;re calling about");
    expect(xml).toContain("<Redirect method=\"POST\">");
    expect(xml).not.toContain("<Hangup");
    expect(xml).not.toContain("<Reject");
    const actionAttr = xml.match(/action="([^"]+)"/)?.[1] ?? "";
    expect(actionAttr).toContain("&amp;");
    expect(actionAttr).not.toContain("&transcript=");
  });
});
