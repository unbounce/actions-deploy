import { spawn, exec } from "child_process";

export class ShellError extends Error {
  constructor(public message: string, public output: string) {
    super(message);
  }
}

export const shell = async (
  commands: string[],
  extraEnv: Record<string, string> = {}
): Promise<string> => {
  const output: string[] = [];
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...extraEnv,
    };
    const options = { env, cwd: process.cwd() };
    // TODO shell escape command
    const child = spawn("bash", ["-e", "-c", commands.join("\n")], options);
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
