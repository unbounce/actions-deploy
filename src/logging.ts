const prettyStringify = (thing: any) => {
  if (typeof thing === "object") {
    try {
      return JSON.stringify(thing, null, 2);
    } catch (ex) {
      // move on
    }
  }

  return String(thing);
};

const stringifyArgs = (...args: any[]) => args.map(prettyStringify).join("\n");

export const warning = (...args: any[]) =>
  console.log(`::warning::${stringifyArgs(args)}`);
export const error = (...args: any[]) =>
  console.log(`::error::${stringifyArgs(args)}`);
export const debug = (...args: any[]) =>
  console.log(`::debug::${stringifyArgs(args)}`);
