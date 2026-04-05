import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface UseSpeechToTextOptions {
  lang?: string; // BCP-47 language code, default: navigator.language || 'en-US'
  continuous?: boolean; // Keep listening after pause, default: true (false for Safari)
  interimResults?: boolean; // Show partial results, default: true
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (errorCode: string) => void;
  onEnd?: () => void;
}

interface UseSpeechToTextReturn {
  isListening: boolean; // True only AFTER onstart fires (not on start() call)
  isSupported: boolean; // Feature detection + secure context check at mount time
  transcript: string; // Current interim transcript (replaces itself each update)
  finalizedText: string; // Accumulated finalized text during this listening session
  startListening: () => void;
  stopListening: () => void; // Graceful stop — allows final results to fire
  abortListening: () => void; // Hard stop — suppresses pending results (use on send)
  toggleListening: () => void;
  error: string | null;
}

// 'network' included as fatal to prevent rapid restart loops during outages.
// User must manually click mic again to retry after network recovery.
const FATAL_ERRORS = new Set(["not-allowed", "audio-capture", "service-not-allowed"]);

const getErrorMessage = (errorCode: string): string => {
  switch (errorCode) {
    case "not-allowed":
      return "Microphone permission denied";
    case "audio-capture":
      return "No microphone found";
    case "network":
      return "Network error — speech recognition unavailable";
    case "service-not-allowed":
      return "Voice input is not available in this browser";
    case "no-speech":
      return "No speech detected";
    case "language-not-supported":
      return "Language not supported by your browser";
    case "bad-grammar":
      return "Speech recognition configuration error";
    case "aborted":
      return ""; // Silent — user/programmatic abort
    default:
      return `Speech recognition error: ${errorCode}`;
  }
};

const useSpeechToText = (options: UseSpeechToTextOptions = {}): UseSpeechToTextReturn => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState(""); // Current interim
  const [finalizedText, setFinalizedText] = useState(""); // Accumulated finals this session
  const [error, setError] = useState<string | null>(null);

  // Feature detection (at mount time)
  const isSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    const hasAPI = "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
    // window.isSecureContext covers https, localhost, 127.0.0.1, [::1], *.localhost
    return hasAPI && window.isSecureContext;
  }, []);

  // Safari detection — continuous mode is unreliable on Safari
  const isSafari = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  }, []);

  // Refs: lazy recognition instance, intent tracking, mounted guard
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const shouldBeListeningRef = useRef(false); // Intent flag for restart logic
  const lastErrorRef = useRef<string | null>(null); // Track last error for restart gating
  const isMountedRef = useRef(true); // Prevent setState after unmount (true for StrictMode compat)
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Prevent error dismiss races

  // Store ALL callbacks in refs to avoid stale closures.
  // Callers may forget useCallback — refs protect against this.
  const onTranscriptRef = useRef(options.onTranscript);
  const onErrorRef = useRef(options.onError);
  const onEndRef = useRef(options.onEnd);
  useEffect(() => {
    onTranscriptRef.current = options.onTranscript;
  }, [options.onTranscript]);
  useEffect(() => {
    onErrorRef.current = options.onError;
  }, [options.onError]);
  useEffect(() => {
    onEndRef.current = options.onEnd;
  }, [options.onEnd]);

  // Create recognition instance (called once on first startListening)
  const createRecognition = useCallback((): SpeechRecognition => {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognitionClass();

    // Disable continuous mode — it causes duplicate text across session restarts.
    // Each mic click = one clean recognition session.
    recognition.continuous = false;
    recognition.interimResults = options.interimResults ?? true;
    recognition.lang = options.lang ?? navigator.language ?? "en-US";

    // Non-continuous mode: one result set per session.
    // Rebuild from index 0 every time to get the latest transcript.
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (!isMountedRef.current) return;

      // In non-continuous mode, results[0] is the only result.
      // It starts as interim and becomes final when speech ends.
      const result = event.results[0];
      if (!result) return;

      const text = result[0].transcript;
      if (result.isFinal) {
        setFinalizedText(text);
        setTranscript("");
      } else {
        setTranscript(text);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (!isMountedRef.current) return;
      lastErrorRef.current = event.error;

      const message = getErrorMessage(event.error);
      if (message) {
        setError(message);
        // Clear previous timeout to prevent races between multiple errors
        if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
        errorTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) setError(null);
          errorTimeoutRef.current = null;
        }, 5000);
      }

      // For fatal errors, update intent flag to prevent restart
      if (FATAL_ERRORS.has(event.error)) {
        shouldBeListeningRef.current = false;
      }

      onErrorRef.current?.(event.error);
    };

    // isListening is set true AFTER recognition actually starts (not on start() call)
    recognition.onstart = () => {
      if (!isMountedRef.current) return;
      setIsListening(true);
      lastErrorRef.current = null;
    };

    recognition.onend = () => {
      if (!isMountedRef.current) return;

      // Session ended — commit results and stop
      setIsListening(false);
      setTranscript("");
      shouldBeListeningRef.current = false;
      onEndRef.current?.();
    };

    // onspeechend is NOT used for state changes — it fires when the user stops speaking
    // but before recognition finishes processing. Do NOT set isListening=false here.

    return recognition;
  }, [isSafari, options.continuous, options.interimResults, options.lang]);

  const startListening = useCallback(() => {
    if (!isSupported) return;
    if (shouldBeListeningRef.current) return; // Prevent double-click abort/restart cycle

    if (!recognitionRef.current) {
      recognitionRef.current = createRecognition();
    }

    shouldBeListeningRef.current = true;
    lastErrorRef.current = null;
    setError(null);
    setFinalizedText(""); // Reset accumulated text for new session
    setTranscript("");
    // Note: isListening is NOT set here — it's set in onstart callback

    try {
      recognitionRef.current.start();
    } catch (e) {
      // If already started, abort and retry after a short delay
      recognitionRef.current?.abort();
      setTimeout(() => {
        if (isMountedRef.current && shouldBeListeningRef.current) {
          try {
            recognitionRef.current?.start();
          } catch {
            /* give up */
          }
        }
      }, 100);
    }
  }, [isSupported, createRecognition]);

  const stopListening = useCallback(() => {
    shouldBeListeningRef.current = false; // MUST be set BEFORE stop to prevent onend restart
    recognitionRef.current?.stop(); // stop() allows final results to fire
    setTranscript("");
    // NOTE: do NOT clear finalizedText here — parent reads it after stop
  }, []);

  // abortListening: hard stop, no final results — use in handleSend to prevent stray text
  const abortListening = useCallback(() => {
    shouldBeListeningRef.current = false;
    recognitionRef.current?.abort(); // abort() suppresses pending final results
    setTranscript("");
    // NOTE: do NOT clear finalizedText here — parent reads it after abort for send
    setIsListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) stopListening();
    else startListening();
  }, [isListening, startListening, stopListening]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true; // Set true in effect for StrictMode re-mount compat
    return () => {
      isMountedRef.current = false;
      shouldBeListeningRef.current = false; // Prevent restart in onend
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    };
  }, []);

  // Visibility change handler: stop + clear intent on tab hide.
  // User must manually click mic again when returning — auto-resume causes not-allowed in Chrome.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && isListening) {
        // Stop AND clear intent — background tab restart fires not-allowed in Chrome
        shouldBeListeningRef.current = false;
        recognitionRef.current?.stop();
        if (isMountedRef.current) {
          setIsListening(false);
          setTranscript("");
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [isListening]);

  return {
    isListening,
    isSupported,
    transcript,
    finalizedText,
    startListening,
    stopListening,
    abortListening,
    toggleListening,
    error,
  };
};

export default useSpeechToText;
