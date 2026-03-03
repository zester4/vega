
import { markdownToHtml, escapeHtml } from './src/telegram';

const testCases = [
    {
        name: "Interleaved tags (the reported error case)",
        input: "`code * italic` and more * text",
        // Expected: <code>code * italic</code> and more <i> text</i>
        // (Note: lone * at end might not match depending on regex, but the key is the code protection)
    },
    {
        name: "Code block with markdown chars",
        input: "```js\nconst x = a * b;\n```\nAnd some *italic* text.",
    },
    {
        name: "Nested formatting",
        input: "**Bold and _italic_ text**",
    },
    {
        name: "Long message with tags",
        input: "A".repeat(4000) + " **bold end**",
    }
];

console.log("--- Telegram HTML Test ---");
testCases.forEach(tc => {
    try {
        const output = markdownToHtml(tc.input);
        console.log(`\n[PASS?] ${tc.name}`);
        console.log(`Input:  ${tc.input.slice(0, 50)}${tc.input.length > 50 ? '...' : ''}`);
        console.log(`Output: ${output.slice(0, 100)}${output.length > 100 ? '...' : ''}`);

        // Basic valid HTML check (look for common interleaving patterns)
        if (output.includes("<code><i>") || output.includes("<i><code>")) {
            console.log("  ⚠️ WARNING: Potential interleaving detected!");
        }
    } catch (err) {
        console.log(`\n[FAIL] ${tc.name}: ${err}`);
    }
});
