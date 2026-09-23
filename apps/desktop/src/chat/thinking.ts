/** Never show an unfinished think tag as part of the answer. */
export function splitThinking(text: string) {
  let thinking = "";
  const answer = text.replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_, thought: string) => {
    thinking += thought;
    return "";
  });
  return { answer: answer.replace(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/, ""), thinking };
}
