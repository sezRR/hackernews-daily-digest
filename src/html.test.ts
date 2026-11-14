import { assert, it } from "@effect/vitest";
import { htmlToText } from "./html.js";

it("turns paragraphs into blank lines and decodes entities", () => {
  assert.strictEqual(htmlToText("Don&#x27;t stop<p>Second &amp; last"), "Don't stop\n\nSecond & last");
});

it("uses the full href rather than HN's shortened link label", () => {
  const html =
    'See <a href="https:&#x2F;&#x2F;a.com&#x2F;long&#x2F;path" rel="nofollow">https:&#x2F;&#x2F;a.com&#x2F;lo...</a> now';
  assert.strictEqual(htmlToText(html), "See https://a.com/long/path now");
});

it("keeps italics as markdown emphasis", () => {
  assert.strictEqual(htmlToText("a <i>lot</i> of it"), "a *lot* of it");
});

it("fences code blocks and decodes their contents", () => {
  assert.strictEqual(
    htmlToText("Try:<p><pre><code>  if x &lt; 1:\n    y()\n</code></pre>"),
    "Try:\n\n```\n  if x < 1:\n    y()\n```",
  );
});

it("does not decode entities twice", () => {
  assert.strictEqual(htmlToText("write &amp;lt; for less-than"), "write &lt; for less-than");
});

it("keeps tags a user typed as visible text", () => {
  assert.strictEqual(htmlToText("the &lt;script&gt; tag"), "the <script> tag");
});

it("leaves unknown or out-of-range entities alone", () => {
  assert.strictEqual(htmlToText("&bogus; &#x110000;"), "&bogus; &#x110000;");
});
