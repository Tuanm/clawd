// Debug safeCut behavior
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
  console.log(`Step 1: cp=${cp}, result.length=${result.length}, result="${result.substring(0, 20)}..."`);

  // Close open fences if room permits
  const fenceCount = (result.match(/```/g) || []).length;
  console.log(`Step 2: fenceCount=${fenceCount}, odd=${fenceCount % 2 !== 0}`);

  if (fenceCount % 2 !== 0 && cp > fenceClose.length) {
    console.log(`Step 3: Attempting fence closure. cp=${cp}, fenceClose.length=${fenceClose.length}`);
    cp = Math.min(maxLength - fenceClose.length, text.length);
    cp = surrogateAdjust(text, cp);
    result = text.slice(0, cp) + fenceClose;
    console.log(`Step 4: New cp=${cp}, result.length=${result.length}`);
  }
  return result;
}

// Test case that failed
console.log("\n=== Test: maxLength=5 ===");
const text1 = "```typescript\nconst x = 42;";
const result1 = safeCut(text1, 5);
console.log(`Final: "${result1}", length=${result1.length}, fences=${(result1.match(/```/g) || []).length}\n`);

console.log("\n=== Test: maxLength=6 ===");
const text2 = "```javascript\ncode";
const result2 = safeCut(text2, 6);
console.log(`Final: "${result2}", length=${result2.length}, fences=${(result2.match(/```/g) || []).length}\n`);
