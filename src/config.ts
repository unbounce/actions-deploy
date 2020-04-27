export type DeploymentType = "npm" | "make";

export const config = {
  statusCheckContext: "QA",
  preProductionEnvironment: "integration",
  deploymentType: "npm" as DeploymentType, // npm | make
};
