/** Add reading breaks without changing the recognized words or their order. */
export function readableTranscript(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => {
      const words = paragraph.trim().split(/\s+/);
      const result: string[] = [];
      let line: string[] = [];
      for (const word of words) {
        line.push(word);
        if ((line.length >= 45 && /[.!?]["'”’)]?$/.test(word)) || line.length >= 85) {
          result.push(line.join(" "));
          line = [];
        }
      }
      if (line.length) result.push(line.join(" "));
      return result.join("\n\n");
    })
    .join("\n\n");
}
