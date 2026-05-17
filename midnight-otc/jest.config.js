/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.ts"],
  moduleNameMapper: {
    "^../../shared/(.*)$": "<rootDir>/shared/$1",
    "^../shared/(.*)$": "<rootDir>/shared/$1",
    "^../relayer/src/(.*)$": "<rootDir>/relayer/src/$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { module: "commonjs", target: "ES2020", esModuleInterop: true } }],
  },
};
