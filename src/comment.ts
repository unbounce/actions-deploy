import Parsimmon from "parsimmon";
import type { Context } from "probot";

export const warning = (text: string) => `:warning: ${text}`;
export const error = (text: string) => `:x: ${text}`;
export const success = (text: string) => `:white_check_mark: ${text}`;

export const details = (summary: string, body: string) => {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
};

export const mention = (body0: string) => {
  const body = body0.indexOf(",") === 0 ? body0 : ` ${body0}`;
  return `@${process.env.GITHUB_ACTOR}${body}`;
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

export class Comment {
  private id?: number;
  private lines: string[] = [];
  private footer: string[] = ["---"];

  constructor(
    private context: Context,
    private issueNumber: number,
    footer?: string | string[]
  ) {
    if (footer) {
      this.footer = this.footer.concat(footer);
    }
  }

  async append(lines: string | string[]) {
    this.lines = this.lines.concat(lines);
    await this.apply(this.lines);
  }

  async ephemeral(ephemeralLines: string | string[]) {
    await this.apply(this.lines.concat(ephemeralLines));
  }

  separator() {
    this.lines.push("---");
  }

  private apply(lines: string[]) {
    if (typeof this.id === "undefined") {
      return this.create(lines);
    } else {
      return this.update(this.id, lines);
    }
  }

  private update(id: number, lines: string[]) {
    const params = this.context.repo({
      comment_id: id,
      body: lines.concat(this.footer).join("\n\n"),
    });
    return this.context.github.issues.updateComment(params);
  }

  private async create(lines: string[]) {
    const body = lines.concat(this.footer).join("\n\n");
    const params = this.context.repo({
      issue_number: this.issueNumber,
      body,
    });
    const comment = await this.context.github.issues.createComment(params);
    this.id = comment.data.id;
  }
}
