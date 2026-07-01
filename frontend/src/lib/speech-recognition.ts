/**
 * Web Speech API helpers — same pattern as Visit Capture (EstimateRequestDetail).
 */

import { useRef, useState } from "preact/hooks";

export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult:
    | ((e: {
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string }; length: number }>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  return (
    (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
      .webkitSpeechRecognition ||
    null
  );
}

export function useSpeechRecognition(onAppendFinal: (chunk: string) => void) {
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const pendingRef = useRef("");
  const [recording, setRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [micDenied, setMicDenied] = useState(false);
  const [supported] = useState(() => speechRecognitionCtor() != null);

  const stopRecording = () => {
    recRef.current?.stop();
    recRef.current = null;
    setRecording(false);
    setInterimTranscript("");
  };

  const toggleRecording = () => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;

    if (recording) {
      stopRecording();
      const chunk = pendingRef.current.trim();
      pendingRef.current = "";
      if (chunk) onAppendFinal(chunk);
      return;
    }

    setMicDenied(false);
    pendingRef.current = "";
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let interim = "";
      let finalChunk = "";
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        const t = result[0].transcript;
        if (result.isFinal) finalChunk += t;
        else interim += t;
      }
      if (finalChunk) pendingRef.current += finalChunk;
      setInterimTranscript(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setMicDenied(true);
      }
      stopRecording();
    };
    rec.onend = () => {
      setRecording(false);
      setInterimTranscript("");
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setRecording(true);
    } catch {
      setMicDenied(true);
    }
  };

  const flushAndStop = (): string => {
    const chunk = pendingRef.current.trim();
    pendingRef.current = "";
    stopRecording();
    return chunk;
  };

  return {
    recording,
    interimTranscript,
    micDenied,
    supported,
    toggleRecording,
    stopRecording,
    flushAndStop,
  };
}
