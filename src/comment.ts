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

export const runLink = (text: string) => {
  const url = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}?check_suite_focus=true`;
  return `[${text}](${url})`;
};
