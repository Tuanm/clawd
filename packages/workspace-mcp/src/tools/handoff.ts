interface HandoffResult {
  status: 'waiting' | 'resumed' | 'timed_out';
  vnc_url?: string;
  duration_seconds: number;
}

// Simple in-memory signal mechanism
let resumeSignal: (() => void) | null = null;

export function signalResume(): void {
  if (resumeSignal) {
    resumeSignal();
    resumeSignal = null;
  }
}

export async function pauseForHuman(reason: string, instructions: string, timeoutSeconds = 300): Promise<HandoffResult> {
  const startTime = Date.now();
  const vncPort = process.env.NOVNC_PORT || '6080';
  const vncUrl = `http://localhost:${vncPort}/vnc.html`;

  console.log(`[Handoff] PAUSING - Human input required:`);
  console.log(`[Handoff] Reason: ${reason}`);
  console.log(`[Handoff] Instructions: ${instructions}`);
  console.log(`[Handoff] noVNC URL: ${vncUrl}`);
  console.log(`[Handoff] Timeout: ${timeoutSeconds}s`);

  // Wait for resume signal or timeout
  const result = await new Promise<HandoffResult>(resolve => {
    const timeout = setTimeout(() => {
      resumeSignal = null;
      resolve({
        status: 'timed_out',
        vnc_url: vncUrl,
        duration_seconds: Math.round((Date.now() - startTime) / 1000),
      });
    }, timeoutSeconds * 1000);

    resumeSignal = () => {
      clearTimeout(timeout);
      resolve({
        status: 'resumed',
        vnc_url: vncUrl,
        duration_seconds: Math.round((Date.now() - startTime) / 1000),
      });
    };
  });

  return result;
}
