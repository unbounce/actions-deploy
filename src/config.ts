const input = (name: string) => {
  const envName = `INPUT_${name}`.toUpperCase().replace(" ", "_");
  const value = process.env[envName];
  if (typeof value === "undefined") {
    throw new Error(`Input ${name} was not provided`);
  }
  return value;
};

export const config = {
  isComponent: "ACTIONS_DEPLOY_NAME" in process.env,
  componentName: process.env[`ACTIONS_DEPLOY_NAME`],
  statusCheckContext: "QA",
  productionEnvironment: input("production-environment"),
  preProductionEnvironment: input("pre-production-environment"),
  deployCommand: input("deploy"),
  releaseCommand: input("release"),
  verifyCommand: input("verify"),
  setupCommand: input("setup"),
};
