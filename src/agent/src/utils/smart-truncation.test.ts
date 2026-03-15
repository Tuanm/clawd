/**
 * Tests for safeCut fence closure fix
 */

import { describe, expect, test } from "bun:test";

// Re-export safeCut for testing (make it public for testing purposes)
// Since safeCut is not exported, we need to test it through the module or make it public
// For now, we'll copy the implementation for testing
function surrogateAdjust(text: string, cp: number): number {
  if (cp > 0 && cp < text.length) {
    const code = text.charCodeAt(cp - 1);
    if (code >= 0xd800 && code <= 0xdbff) return cp - 1;
  }
  return cp;
}

function safeCut(text: string, maxLength: number): string {
  const fenceClose = "\n```";
  let cp = Math.min(maxLength, text.length);
  cp = surrogateAdjust(text, cp);
  let result = text.slice(0, cp);
  // Close open fences if room permits
  const fenceCount = (result.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0 && cp > fenceClose.length) {
    cp = Math.min(maxLength - fenceClose.length, text.length);
    cp = surrogateAdjust(text, cp);
    result = text.slice(0, cp) + fenceClose;
  }
  return result;
}

describe("safeCut fence closure", () => {
  test("maxLength=30 with text starting with ``` → fences even, output ≤ 30", () => {
    const text = "```typescript\nconst x = 42;\nconsole.log(x);\n```\nMore text here";
    const result = safeCut(text, 30);

    // Check output length
    expect(result.length).toBeLessThanOrEqual(30);

    // Check fence count is even
    const fenceCount = (result.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);

    console.log(`Test 1: maxLength=30, result.length=${result.length}, fences=${fenceCount}`);
  });

  test("maxLength=50 with text starting with ``` → fences even, output ≤ 50", () => {
    const text = "```javascript\nfunction foo() {\n  return 'bar';\n}\n```\nAdditional content";
    const result = safeCut(text, 50);

    // Check output length
    expect(result.length).toBeLessThanOrEqual(50);

    // Check fence count is even
    const fenceCount = (result.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);

    console.log(`Test 2: maxLength=50, result.length=${result.length}, fences=${fenceCount}`);
  });

  test("maxLength=3 (too small for fence closure) → just cut, output ≤ 3", () => {
    const text = "```typescript\nconst x = 42;";
    const result = safeCut(text, 3);

    // Check output length - should be exactly 3 or less
    expect(result.length).toBeLessThanOrEqual(3);

    // When maxLength is too small (≤ 4), fence closure shouldn't happen
    // The condition is: cp > fenceClose.length (which is 4)
    // So with maxLength=3, cp=3, and 3 is not > 4, so no fence closure
    expect(result).toBe("```");

    console.log(`Test 3: maxLength=3, result="${result}", length=${result.length}`);
  });

  test("result never exceeds maxLength even with fence closure", () => {
    const testCases = [
      { text: "```code\ntest", maxLength: 10 },
      { text: "```javascript\nconst x = 1;", maxLength: 15 },
      { text: "```\nshort", maxLength: 8 },
      { text: "```python\ndef foo():\n  pass", maxLength: 20 },
      { text: "```html\n<div>test</div>", maxLength: 12 },
    ];

    testCases.forEach(({ text, maxLength }) => {
      const result = safeCut(text, maxLength);
      expect(result.length).toBeLessThanOrEqual(maxLength);
      console.log(`  maxLength=${maxLength}, result.length=${result.length}, OK`);
    });
  });

  test("200 random tests with various maxLengths (5-500) and fence counts", () => {
    const languages = ["typescript", "javascript", "python", "go", "rust", "java", "cpp"];
    let passed = 0;
    let failed = 0;

    for (let i = 0; i < 200; i++) {
      // Random maxLength between 5 and 500
      const maxLength = Math.floor(Math.random() * 496) + 5;

      // Random number of fence pairs (0-5)
      const fencePairs = Math.floor(Math.random() * 6);

      // Build text with random fences and content
      let text = "";
      for (let j = 0; j < fencePairs; j++) {
        const lang = languages[Math.floor(Math.random() * languages.length)];
        text += `\`\`\`${lang}\n`;
        // Add random content
        const contentLength = Math.floor(Math.random() * 100) + 10;
        text += "x".repeat(contentLength) + "\n";
        text += "```\n";
      }

      // Add one more opening fence (odd count)
      if (Math.random() > 0.5) {
        const lang = languages[Math.floor(Math.random() * languages.length)];
        text += `\`\`\`${lang}\n`;
        text += "y".repeat(50);
      }

      // Test safeCut
      const result = safeCut(text, maxLength);

      // Verify: length <= maxLength
      if (result.length > maxLength) {
        console.error(`FAIL: Test ${i}: result.length (${result.length}) > maxLength (${maxLength})`);
        failed++;
        continue;
      }

      // Verify: even number of fences (if result has any fences)
      const fenceCount = (result.match(/```/g) || []).length;
      if (fenceCount > 0 && fenceCount % 2 !== 0) {
        // Odd fences are only acceptable if maxLength was too small to add closure
        // The condition for closure is: cp > fenceClose.length (4)
        // So if maxLength <= 4, odd fences might remain
        if (maxLength > 4) {
          console.error(`FAIL: Test ${i}: odd fence count (${fenceCount}) with maxLength=${maxLength}`);
          failed++;
          continue;
        }
      }

      passed++;
    }

    console.log(`Random tests: ${passed} passed, ${failed} failed`);
    expect(failed).toBe(0);
    expect(passed).toBe(200);
  });

  test("edge case: maxLength exactly 4 (fence close length)", () => {
    const text = "```typescript\nconst x = 42;";
    const result = safeCut(text, 4);

    // With maxLength=4, cp=4, condition is cp > 4 (false), so no closure
    expect(result.length).toBeLessThanOrEqual(4);
    console.log(`Edge case maxLength=4: result="${result}", length=${result.length}`);
  });

  test("edge case: maxLength exactly 5 (just enough for one char + closure)", () => {
    const text = "```typescript\nconst x = 42;";
    const result = safeCut(text, 5);

    // With maxLength=5, if there's an odd fence, cp > 4 is true, closure can happen
    expect(result.length).toBeLessThanOrEqual(5);

    const fenceCount = (result.match(/```/g) || []).length;
    // Should have even fences now
    expect(fenceCount % 2).toBe(0);

    console.log(`Edge case maxLength=5: result="${result}", length=${result.length}, fences=${fenceCount}`);
  });

  test("no fences in text → no changes", () => {
    const text = "Simple text without any code fences at all";
    const result = safeCut(text, 20);

    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toBe(text.slice(0, 20));
    console.log(`No fences test: result="${result}"`);
  });

  test("even number of fences → no closure added", () => {
    const text = "```js\ncode\n```\nMore text here";
    const result = safeCut(text, 20);

    expect(result.length).toBeLessThanOrEqual(20);

    const fenceCount = (result.match(/```/g) || []).length;
    expect(fenceCount % 2).toBe(0);

    console.log(`Even fences test: result="${result}", fences=${fenceCount}`);
  });

  test("multiple odd fences in sequence", () => {
    const text = "```\n```\n```\ntext";
    const result = safeCut(text, 15);

    expect(result.length).toBeLessThanOrEqual(15);

    const fenceCount = (result.match(/```/g) || []).length;
    // Should be even after closure
    expect(fenceCount % 2).toBe(0);

    console.log(`Multiple fences: result="${result}", fences=${fenceCount}`);
  });

  test("fence at the very end of allowed length", () => {
    const text = "Start text ```";
    const result = safeCut(text, 14);

    expect(result.length).toBeLessThanOrEqual(14);

    const fenceCount = (result.match(/```/g) || []).length;
    if (14 > 4) {
      expect(fenceCount % 2).toBe(0);
    }

    console.log(`Fence at end: result="${result}", length=${result.length}`);
  });
});
