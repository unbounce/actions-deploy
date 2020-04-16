module.exports = {
  "*.{ts,tsx}": [
    "tslint --config tslint.json --project tsconfig.json --fix",
    "prettier --write"
  ],
  // Use this configuration format to not pass filename arguments to `npm run build`
  "**/*.ts": () => ['npm run build', 'git add dist/index.js'],
  "package(-lock)?.json": () => ['npm run build', 'git add dist/index.js'],
};
