import { logToDetails } from "../comment";

describe("logToDetails", () => {
  test("with no groups", () => {
    const log = "one\ntwo\nthree";
    expect(logToDetails(log)).toEqual(`\`\`\`\n${log}\n\`\`\``);
  });

  test("with log outside group", () => {
    const log = "before\n::group::One\none\n::endgroup::";
    expect(logToDetails(log)).toEqual(`\`\`\`\n${log}\n\`\`\``);
  });

  test("one group", () => {
    const log = "::group::One\none\n::endgroup::";
    const details = logToDetails(log);
    expect(details.includes("::")).toBeFalsy();
    expect(details).toMatchSnapshot();
  });

  test("no name", () => {
    const log = "::group::\none\n::endgroup::";
    const details = logToDetails(log);
    expect(details.includes("::")).toBeFalsy();
    expect(details).toMatchSnapshot();
  });

  test("many groups", () => {
    const log =
      "::group::One\none\n::endgroup::\n::group::Two\ntwo\n::endgroup::";
    const details = logToDetails(log);
    expect(details.includes("::")).toBeFalsy();
    expect(details).toMatchSnapshot();
  });

  test("many groups with whitespace", () => {
    const log =
      "::group::One\none\n::endgroup::\n \n::group::Two\ntwo\n::endgroup::";
    const details = logToDetails(log);
    expect(details.includes("::")).toBeFalsy();
    expect(details).toMatchSnapshot();
  });

  test("with special characters", () => {
    const log =
      "::group::One\none\n1\n-->>--=\n::endgroup::\n::group::Two\ntwo\n::endgroup::";
    const details = logToDetails(log);
    expect(details.includes("::")).toBeFalsy();
    expect(details).toMatchSnapshot();
  });

  test("missing endgroup", () => {
    const log = "::group::One\none\n::endgroup::\n::group::Two\ntwo\n";
    const details = logToDetails(log);
    expect(details.includes("::")).toBeFalsy();
    expect(details).toMatchSnapshot();
  });
});
