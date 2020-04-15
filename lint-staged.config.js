module.exports = {
  "*.{ts,tsx}": [
    "tslint --config tslint.json --project tsconfig.json --fix",
    "prettier --write"
  ],
  // Use this configuration format to not pass filename arguements
  "**/*.ts": () => ['npm run build', 'git add dist/index.js']
};
