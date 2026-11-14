const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  // One pass, so "&amp;lt;" becomes the literal text "&lt;" and is not decoded twice.
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (!code.startsWith("#")) return NAMED_ENTITIES[code.toLowerCase()] ?? match;
    const isHex = code[1] === "x" || code[1] === "X";
    const point = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

/**
 * Converts the small HTML subset the Hacker News API returns (<p>, <a>, <i>, <pre><code>)
 * to plain text with light markdown. Tags are removed before entities are decoded, so
 * text a user typed as "<script>" (sent as "&lt;script&gt;") survives as text.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(
      /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
      (_, code: string) => `\n\n\`\`\`\n${code.replace(/\n+$/, "")}\n\`\`\`\n\n`,
    )
    // HN shortens link labels with "...", so the href is the only complete URL.
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/g, "$1")
    .replace(/<\/?i>/g, "*")
    .replace(/<p>/g, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text).replace(/\n{3,}/g, "\n\n").trim();
}
