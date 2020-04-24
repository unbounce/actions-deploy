export const details = (summary: string, body: string) => {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n</details>`;
};

export const mention = (body: string) => {
  return `@${process.env.GITHUB_ACTOR} ${body}`;
};

export const codeBlock = (body: string) => {
  const ticks = "```";
  return `${ticks}\n${body}\n${ticks}`;
};

export const runLink = (text: string) => {
  const url = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}?check_suite_focus=true`;
  return `[${text}](${url})`;
};
