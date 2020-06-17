import { spawn, exec } from "child_process";

export class ShellError extends Error {
  constructor(public message: string, public output: string) {
    super(message);
  }
}

export const shell = (
  commands: string[],
  extraEnv: Record<string, string> = {}
): Promise<string> => {
  return shellWithOutput(commands, extraEnv)[0];
};

export const shellWithOutput = (
  commands: string[],
  extraEnv: Record<string, string> = {}
): [Promise<string>, string[]] => {
  const output: string[] = [];
  const promise: Promise<string> = new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...extraEnv,
    };
    const options = { env, cwd: process.cwd() };
    const commandsWithTracing = commands.reduce((acc, command) => {
      if (!command.startsWith("echo")) {
        acc.push(`echo ${command}`);
      }
      acc.push(command);
      return acc;
    }, [] as string[]);
    // TODO shell escape command
    const child = spawn(
      "bash",
      ["-e", "-c", commandsWithTracing.join("\n")],
      options
    );
    child.stdout.on("data", (data) => {
      const str = data.toString();
      output.push(str);
      console.log(str);
    });
    child.stderr.on("data", (data) => {
      const str = data.toString();
      output.push(str);
      console.error(str);
    });
    child.on("error", (e) => {
      reject(e);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output.join("\n"));
      } else {
        reject(
          new ShellError(`exited with status code ${code}`, output.join("\n"))
        );
      }
    });
  });
  return [promise, output];
};

export const shellOutput = (command: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(command, (e, stdout, stderr) => {
      if (stderr) {
        console.error(stderr);
      }
      if (stdout) {
        console.log(stdout);
      }
      if (e) {
        reject(new ShellError(e.message, [stdout, stderr].join("\n")));
      } else {
        resolve(stdout);
      }
    });
  });
};
