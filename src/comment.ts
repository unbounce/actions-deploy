export const details = (summary: string, body: string) => {
  return `<details><summary>${summary}</summary>${body}</details>`;
};

export const mention = () => {
  return `@${process.env.GITHUB_ACTOR} `;
};

export const codeBlock = (body: string) => {
  const ticks = "```";
  return `${ticks}${body}${ticks}`;
};
