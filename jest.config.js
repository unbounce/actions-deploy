module.exports = {
  coverageReporters: ['lcov', 'text'],
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ["<rootDir>/jest.setup.js"]
};
