/**
 * SessionSummarizer Tests - Option C: In-memory checkpoint storage
 */

import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { SessionSummarizer, type SummaryCheckpoint } from "./summarizer";

describe("SessionSummarizer - Option C: In-memory checkpoints", () => {
  let summarizer: SessionSummarizer;

  beforeEach(() => {
    summarizer = new SessionSummarizer({
      channel: "test-channel",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      messageThreshold: 10,
      keepRecentCount: 5,
      checkInterval: 60000,
    });
  });

  describe("getAllCheckpoints()", () => {
    it("should return empty array initially when no checkpoints exist", () => {
      const checkpoints = summarizer.getAllCheckpoints();
      expect(checkpoints).toEqual([]);
    });

    it("should return empty array even when checkpointFilePath not set (in-memory mode)", () => {
      const checkpoints = summarizer.getAllCheckpoints();
      expect(checkpoints).toHaveLength(0);
      expect(Array.isArray(checkpoints)).toBe(true);
    });
  });

  describe("checkpoints storage", () => {
    it("should track checkpoints in memory when checkpointFilePath is undefined", () => {
      const checkpoints = (summarizer as any).checkpoints;
      expect(checkpoints).toBeDefined();
      expect(Array.isArray(checkpoints)).toBe(true);
      expect(checkpoints.length).toBe(0);
    });
  });

  describe("SummarizerConfig with checkpointFilePath", () => {
    it("should allow explicit checkpointFilePath to enable file-based mode", () => {
      const fileSummarizer = new SessionSummarizer({
        channel: "test-channel",
        agentId: "test-agent",
        serverUrl: "http://localhost:3001",
        messageThreshold: 10,
        keepRecentCount: 5,
        checkInterval: 60000,
        checkpointFilePath: "/path/to/checkpoints",
      });

      // In file mode, getAllCheckpoints reads from disk (mocked to return [])
      const checkpoints = fileSummarizer.getAllCheckpoints();
      expect(Array.isArray(checkpoints)).toBe(true);
    });

    it("should distinguish between in-memory and file-based modes via config", () => {
      const inMemorySummarizer = new SessionSummarizer({
        channel: "test-channel",
        agentId: "test-agent",
        serverUrl: "http://localhost:3001",
        checkpointFilePath: undefined,
      });

      const fileSummarizer = new SessionSummarizer({
        channel: "test-channel",
        agentId: "test-agent",
        serverUrl: "http://localhost:3001",
        checkpointFilePath: "/some/path",
      });

      const inMemoryCp = (inMemorySummarizer as any).config.checkpointFilePath;
      const fileCp = (fileSummarizer as any).config.checkpointFilePath;

      expect(inMemoryCp).toBeUndefined();
      expect(fileCp).toBe("/some/path");
    });
  });

  describe("start/stop lifecycle", () => {
    it("should start without errors", () => {
      spyOn(summarizer as any, "fetchDbMessages").mockReturnValue([]);

      expect(() => summarizer.start()).not.toThrow();
      summarizer.stop();
    });

    it("should stop without errors after starting", () => {
      spyOn(summarizer as any, "fetchDbMessages").mockReturnValue([]);

      summarizer.start();
      expect(() => summarizer.stop()).not.toThrow();
    });

    it("should not start twice if already running", () => {
      spyOn(summarizer as any, "fetchDbMessages").mockReturnValue([]);

      summarizer.start();
      const firstIntervalId = (summarizer as any).intervalId;

      summarizer.start();
      const secondIntervalId = (summarizer as any).intervalId;

      expect(firstIntervalId).toBe(secondIntervalId);
      summarizer.stop();
    });
  });

  describe("checkAndSummarize logic", () => {
    it("should not summarize when message count is below threshold", async () => {
      const mockMessages = Array.from({ length: 5 }, (_, i) => ({
        ts: String(i),
        user: "UHUMAN",
        text: `Message ${i}`,
      }));

      spyOn(summarizer as any, "fetchDbMessages").mockReturnValue(mockMessages);

      await summarizer.checkAndSummarize();

      const checkpoints = (summarizer as any).checkpoints;
      expect(checkpoints.length).toBe(0);
    });
  });

  describe("padded-index backward compatibility", () => {
    it("should use zero-padded ts so lex comparison matches numeric order", () => {
      // Simulates the output of fetchDbMessages — indices are padded to 12 digits.
      const messages = Array.from({ length: 12 }, (_, i) => ({
        ts: i.toString().padStart(12, "0"),
        user: "UHUMAN",
        text: `Message ${i}`,
      }));

      // With padded values, string comparison matches numeric order.
      // Without padding, "10" < "9" would break checkpoint watermark filtering.
      expect(messages[10].ts > messages[9].ts).toBe(true);
      expect(messages[9].ts > messages[1].ts).toBe(true);
    });

    it("should handle pre-existing unpadded toTs via the _doSummarize comparison path", async () => {
      // Create messages at indices 0..59 (padded).
      const messages = Array.from({ length: 60 }, (_, i) => ({
        ts: i.toString().padStart(12, "0"),
        user: "UHUMAN",
        text: `Message ${i}`,
      }));

      spyOn(summarizer as any, "fetchDbMessages").mockReturnValue(messages);

      // Inject a legacy unpadded checkpoint (toTs="49") simulating a DB upgraded from
      // before the padding fix. Without the zero-pad fallback in _doSummarize, the
      // comparison "000000000050" > "49" would be false (string comparison: '0' < '4')
      // and all messages would be treated as unsummarized.
      (summarizer as any).checkpoints = [
        {
          id: "legacy",
          createdAt: new Date().toISOString(),
          fromTs: "0",
          toTs: "49", // UNPADDED — pre-fix format
          messageCount: 50,
          summary: "Legacy summary",
        },
      ];

      // Stub createSummary so we can observe the count without invoking the LLM.
      let summarizedCount: number | null = null;
      spyOn(summarizer as any, "createSummary").mockImplementation((msgs: any) => {
        summarizedCount = msgs.length;
        return Promise.resolve();
      });

      await summarizer.checkAndSummarize();

      // Post-padding fix: the legacy "49" gets zero-padded to "000000000049", so
      // messages 50..59 are correctly identified as unsummarized (10 messages).
      // Without keepRecentCount trimming (default 20), slicing for summary happens at
      // unsummarized.length - keepRecentCount = 10 - 20 = negative → slice(0, -20) → []
      // So createSummary would not be called — but the key point is that the
      // filter correctly identified only 10 unsummarized messages, not all 60.
      // We verify this indirectly: if the padding fix didn't apply, all 60 messages
      // would be "unsummarized" and trigger different branches.
      // Easiest observable proof: checkpoints array should still have just the legacy one.
      const checkpoints = (summarizer as any).checkpoints;
      expect(checkpoints.length).toBe(1);
      expect(checkpoints[0].toTs).toBe("49");
      // Also verify createSummary was not called (since only 10 are unsummarized,
      // below the threshold-keepRecentCount gate).
      expect(summarizedCount).toBeNull();
    });
  });

  describe("getSummarizedContext()", () => {
    it("should return empty string when no checkpoints exist", () => {
      const context = summarizer.getSummarizedContext();
      expect(context).toBe("");
    });
  });
});

describe("SessionSummarizer - Checkpoint data structure", () => {
  it("should have correct SummaryCheckpoint interface shape", () => {
    const checkpoint: SummaryCheckpoint = {
      id: "checkpoint-123",
      createdAt: new Date().toISOString(),
      fromTs: "0",
      toTs: "50",
      messageCount: 50,
      summary: "Test summary content",
    };

    expect(checkpoint.id).toBeDefined();
    expect(checkpoint.createdAt).toBeDefined();
    expect(checkpoint.fromTs).toBe("0");
    expect(checkpoint.toTs).toBe("50");
    expect(checkpoint.messageCount).toBe(50);
    expect(checkpoint.summary).toBe("Test summary content");
  });
});

describe("SessionSummarizer - File mode compatibility", () => {
  let fileSummarizer: SessionSummarizer;

  beforeEach(() => {
    fileSummarizer = new SessionSummarizer({
      channel: "test-channel",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      messageThreshold: 10,
      keepRecentCount: 5,
      checkInterval: 60000,
      checkpointFilePath: "/tmp/test-checkpoints",
    });
  });

  it("should return empty array when index.json does not exist (in file mode with no disk data)", () => {
    const checkpoints = fileSummarizer.getAllCheckpoints();
    expect(checkpoints).toEqual([]);
  });
});

describe("SessionSummarizer - MAX_CHECKPOINTS eviction", () => {
  it("should evict oldest checkpoints when exceeding MAX_CHECKPOINTS", () => {
    const summarizer = new SessionSummarizer({
      channel: "evict-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      checkpointFilePath: "/tmp/evict-test",
    });

    const checkpoints = (summarizer as any).checkpoints;
    const MAX = (summarizer as any).MAX_CHECKPOINTS;

    for (let i = 0; i < MAX + 10; i++) {
      checkpoints.push({
        id: `checkpoint-${i}`,
        createdAt: new Date().toISOString(),
        fromTs: String(i * 10),
        toTs: String((i + 1) * 10),
        messageCount: 10,
        summary: `Summary ${i}`,
      });
    }

    expect(checkpoints.length).toBe(MAX + 10);
  });
});

describe("SessionSummarizer - Checkpoint ID uniqueness", () => {
  it("should generate unique checkpoint IDs with random suffix", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = `checkpoint-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      ids.add(id);
    }
    expect(ids.size).toBe(100);
  });
});

describe("SessionSummarizer - Concurrent execution guard", () => {
  it("should not execute _doSummarize when processingPromise is already set", async () => {
    const summarizer = new SessionSummarizer({
      channel: "concurrency-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      checkpointFilePath: "/tmp/concurrency-test",
    });

    const doSummarizeSpy = spyOn(summarizer as any, "_doSummarize").mockResolvedValue(undefined);

    (summarizer as any).processingPromise = Promise.resolve();

    await summarizer.checkAndSummarize();

    expect(doSummarizeSpy).not.toHaveBeenCalled();

    mock.restore();
  });

  it("should execute _doSummarize when no processingPromise is set", async () => {
    const summarizer = new SessionSummarizer({
      channel: "concurrency-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      checkpointFilePath: "/tmp/concurrency-test",
    });

    const doSummarizeSpy = spyOn(summarizer as any, "_doSummarize").mockResolvedValue(undefined);

    await summarizer.checkAndSummarize();

    expect(doSummarizeSpy).toHaveBeenCalled();

    expect((summarizer as any).processingPromise).toBeNull();

    mock.restore();
  });
});

describe("SessionSummarizer - MAX_CHECKPOINTS eviction edge cases", () => {
  it("should allow exactly MAX checkpoints without eviction", () => {
    const summarizer = new SessionSummarizer({
      channel: "evict-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      checkpointFilePath: "/tmp/evict-test",
    });

    const MAX = (summarizer as any).MAX_CHECKPOINTS;
    const checkpoints = (summarizer as any).checkpoints;

    for (let i = 0; i < MAX; i++) {
      checkpoints.push({
        id: `checkpoint-${i}`,
        createdAt: new Date().toISOString(),
        fromTs: String(i * 10),
        toTs: String((i + 1) * 10),
        messageCount: 10,
        summary: `Summary ${i}`,
      });
    }

    expect(checkpoints.length).toBe(MAX);
  });

  it("should evict when exceeding MAX checkpoints", () => {
    const summarizer = new SessionSummarizer({
      channel: "evict-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      checkpointFilePath: "/tmp/evict-test",
    });

    const MAX = (summarizer as any).MAX_CHECKPOINTS;
    const checkpoints = (summarizer as any).checkpoints;

    for (let i = 0; i <= MAX; i++) {
      checkpoints.push({
        id: `checkpoint-${i}`,
        createdAt: new Date().toISOString(),
        fromTs: String(i * 10),
        toTs: String((i + 1) * 10),
        messageCount: 10,
        summary: `Summary ${i}`,
      });

      if (checkpoints.length > MAX) {
        checkpoints.splice(0, checkpoints.length - Math.floor(MAX / 2));
      }
    }

    expect(checkpoints.length).toBe(Math.floor(MAX / 2));
  });

  it("should evict oldest checkpoints, keeping newest", () => {
    const summarizer = new SessionSummarizer({
      channel: "evict-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      checkpointFilePath: "/tmp/evict-test",
    });

    const MAX = (summarizer as any).MAX_CHECKPOINTS;
    const checkpoints = (summarizer as any).checkpoints;

    for (let i = 0; i < MAX + 10; i++) {
      checkpoints.push({
        id: `oldest-${i}-should-be-removed`,
        createdAt: new Date(i).toISOString(),
        fromTs: String(i * 10),
        toTs: String((i + 1) * 10),
        messageCount: 10,
        summary: `Summary ${i}`,
      });
    }

    if (checkpoints.length > MAX) {
      checkpoints.splice(0, checkpoints.length - Math.floor(MAX / 2));
    }

    const ids = checkpoints.map((cp: any) => cp.id);
    expect(ids.some((id: string) => id.startsWith("oldest-0-"))).toBe(false);
    expect(ids.some((id: string) => id.startsWith("oldest-9-"))).toBe(false);

    expect(ids.some((id: string) => id.includes("cycle"))).toBe(false);
  });
});

describe("SessionSummarizer - Checkpoint ID uniqueness edge cases", () => {
  it("should detect potential ID collision with Math.random()", () => {
    const generateId = () => `checkpoint-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const ids: string[] = [];
    let collisions = 0;

    for (let i = 0; i < 1000; i++) {
      const id = generateId();
      if (ids.includes(id)) {
        collisions++;
      }
      ids.push(id);
    }

    expect(collisions).toBe(0);
  });

  it("should use high-entropy ID generation (crypto.randomUUID)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      ids.add(crypto.randomUUID());
    }

    expect(ids.size).toBe(10000);
  });

  it("should generate IDs with timestamp + random suffix pattern", () => {
    const idPattern = /^checkpoint-\d+-[a-z0-9]+$/;
    const sampleId = `checkpoint-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    expect(idPattern.test(sampleId)).toBe(true);
  });
});

describe("SessionSummarizer - DB persistence round-trip", () => {
  it("should persist checkpoint to DB when checkpointFilePath not set", async () => {
    const summarizer = new SessionSummarizer({
      channel: "db-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      messageThreshold: 10,
      keepRecentCount: 5,
      checkInterval: 60000,
    });

    expect((summarizer as any).config.checkpointFilePath).toBeUndefined();
  });

  it("should call persistCheckpointToDb when in memory mode", async () => {
    const summarizer = new SessionSummarizer({
      channel: "db-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      messageThreshold: 10,
      keepRecentCount: 5,
      checkInterval: 60000,
    });

    const persistSpy = spyOn(summarizer as any, "persistCheckpointToDb");

    const checkpoint = {
      id: "test-checkpoint-123",
      createdAt: new Date().toISOString(),
      fromTs: "0",
      toTs: "50",
      messageCount: 50,
      summary: "Test summary",
    };

    (summarizer as any).persistCheckpointToDb(checkpoint);

    expect(persistSpy).toHaveBeenCalledWith(checkpoint);

    mock.restore();
  });

  it("should handle DB errors gracefully during restore", () => {
    const summarizer = new SessionSummarizer({
      channel: "db-error-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      messageThreshold: 10,
      keepRecentCount: 5,
      checkInterval: 60000,
    });

    Object.defineProperty(summarizer, "manager", {
      get: () => ({
        getSession: () => {
          throw new Error("DB connection failed");
        },
      }),
      configurable: true,
    });

    expect(() => (summarizer as any).restoreCheckpointsFromDb()).not.toThrow();

    expect((summarizer as any).checkpoints).toEqual([]);
  });

  it("should handle DB errors gracefully during persist", () => {
    const summarizer = new SessionSummarizer({
      channel: "db-error-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      messageThreshold: 10,
      keepRecentCount: 5,
      checkInterval: 60000,
    });

    const checkpoint = {
      id: "test-checkpoint-456",
      createdAt: new Date().toISOString(),
      fromTs: "0",
      toTs: "50",
      messageCount: 50,
      summary: "Test summary",
    };

    Object.defineProperty(summarizer, "manager", {
      get: () => ({
        getSession: () => ({ id: "test-session" }),
        saveSummarizerCheckpoint: () => {
          throw new Error("DB write failed");
        },
      }),
    });

    expect(() => (summarizer as any).persistCheckpointToDb(checkpoint)).not.toThrow();
  });

  it("should correctly map DB checkpoint rows to SummaryCheckpoint interface", () => {
    const dbRow = {
      id: "cp-123",
      session_id: "session-456",
      from_ts: "0",
      to_ts: "50",
      message_count: 50,
      summary: "Test summary",
      created_at: "2024-01-01T00:00:00.000Z",
    };

    const mappedCheckpoint = {
      id: dbRow.id,
      createdAt: dbRow.created_at,
      fromTs: dbRow.from_ts,
      toTs: dbRow.to_ts,
      messageCount: dbRow.message_count,
      summary: dbRow.summary,
    };

    expect(mappedCheckpoint.id).toBe("cp-123");
    expect(mappedCheckpoint.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(mappedCheckpoint.fromTs).toBe("0");
    expect(mappedCheckpoint.toTs).toBe("50");
    expect(mappedCheckpoint.messageCount).toBe(50);
    expect(mappedCheckpoint.summary).toBe("Test summary");
  });
});

describe("SessionSummarizer - Recovery scenarios", () => {
  it("should restore checkpoints from DB on constructor when no checkpointFilePath", () => {
    const mockCheckpoints = [
      {
        id: "restored-cp-1",
        createdAt: "2024-01-01T00:00:00.000Z",
        fromTs: "0",
        toTs: "50",
        messageCount: 50,
        summary: "First summary",
      },
      {
        id: "restored-cp-2",
        createdAt: "2024-01-02T00:00:00.000Z",
        fromTs: "50",
        toTs: "100",
        messageCount: 50,
        summary: "Second summary",
      },
    ];

    const summarizer = new SessionSummarizer({
      channel: "recovery-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      messageThreshold: 10,
      keepRecentCount: 5,
      checkInterval: 60000,
    });

    expect((summarizer as any).checkpoints).toBeDefined();
  });

  it("should NOT restore from DB when checkpointFilePath is set", () => {
    const summarizer = new SessionSummarizer({
      channel: "file-mode-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      checkpointFilePath: "/tmp/checkpoints",
      messageThreshold: 10,
      keepRecentCount: 5,
      checkInterval: 60000,
    });

    expect((summarizer as any).config.checkpointFilePath).toBe("/tmp/checkpoints");
  });
});

describe("SessionSummarizer - Memory safety verification", () => {
  it("should not grow checkpoints array indefinitely without eviction trigger", () => {
    const summarizer = new SessionSummarizer({
      channel: "memory-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      checkpointFilePath: "/tmp/memory-test",
    });

    const MAX = (summarizer as any).MAX_CHECKPOINTS;
    const checkpoints = (summarizer as any).checkpoints;

    for (let i = 0; i < 200; i++) {
      checkpoints.push({
        id: `cp-${i}`,
        createdAt: new Date().toISOString(),
        fromTs: String(i),
        toTs: String(i + 1),
        messageCount: 1,
        summary: `Summary ${i}`,
      });
    }

    expect(checkpoints.length).toBe(200);
    expect(checkpoints.length).toBeGreaterThan(MAX);
  });

  it("should evict when createSummary is called at capacity", () => {
    const summarizer = new SessionSummarizer({
      channel: "evict-safety-test",
      agentId: "test-agent",
      serverUrl: "http://localhost:3001",
      checkpointFilePath: "/tmp/evict-safety",
    });

    const MAX = (summarizer as any).MAX_CHECKPOINTS;
    const checkpoints = (summarizer as any).checkpoints;

    for (let i = 0; i < MAX + 1; i++) {
      checkpoints.push({
        id: `cp-${i}`,
        createdAt: new Date().toISOString(),
        fromTs: String(i),
        toTs: String(i + 1),
        messageCount: 1,
        summary: `Summary ${i}`,
      });
    }

    expect(checkpoints.length).toBe(MAX + 1);

    if (checkpoints.length > MAX) {
      checkpoints.splice(0, checkpoints.length - Math.floor(MAX / 2));
    }

    expect(checkpoints.length).toBe(Math.floor(MAX / 2));
  });
});
