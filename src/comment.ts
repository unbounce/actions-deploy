import Parsimmon from "parsimmon";

export const details = (summary: string, body: string) => {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
};

export const mention = (body: string) => {
  return `@${process.env.GITHUB_ACTOR} ${body}`;
};

export const codeBlock = (body: string) => {
  const ticks = "```";
  return `${ticks}\n${body}\n${ticks}`;
};

export const code = (body: string) => {
  const tick = "`";
  return `${tick}${body}${tick}`;
};

export const runLink = (text: string) => {
  const url = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}?check_suite_focus=true`;
  return `[${text}](${url})`;
};

const createLogToDetailsParser = () => {
  const startRe = /::group::(\w+)?/;
  const startGroup = Parsimmon.regex(startRe, 1);
  const endRe = /::endgroup::\s*/;
  const endGroup = Parsimmon.regex(endRe);
  const textThenEndgroup = Parsimmon.regex(/[\s\S]*?(?=::endgroup::\s*)/).trim(
    Parsimmon.optWhitespace
  );
  const textThenEnd = Parsimmon.regex(/[\s\S]*?(?!::endgroup::\s*)$/).trim(
    Parsimmon.optWhitespace
  );
  const groupParser = Parsimmon.seqMap(
    Parsimmon.alt(
      Parsimmon.seq(startGroup, textThenEndgroup, endGroup),
      Parsimmon.seq(startGroup, textThenEnd, Parsimmon.end)
    ),
    ([start, middle, _end]) => {
      const name = start ? start : "Details";
      return details(name, codeBlock(middle));
    }
  ).trim(Parsimmon.optWhitespace);
  return groupParser.many();
};
const logToDetailsParser = createLogToDetailsParser();

// Parse log output into <details> blocks based on GitHub Actions group
// annotations.
//
// For example:
//
// ::group::Name
// One
// Two
// ::endgroup::
//
// will be converted to:
//
// <details>
// <summary>Name</summary>
// ```
// One
// Two
// ```
// </details>
//
// Supports multiple groups in succession and the omission of a final
// ::endgroup:: (in the case that the running script was not able to emit it do
// to an earlier failure).
//
// If any text is found outside of a group, or if no groups are used, the log
// output will be returned as a single code block.
//
export const logToDetails = (log: string) => {
  const parsed = logToDetailsParser.parse(log);
  if (parsed.status) {
    return parsed.value.join("\n");
  } else {
    return codeBlock(log);
  }
};
