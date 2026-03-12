/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/src/test/**/*.test.ts'],
    moduleNameMapper: {
        '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
    },
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: {
                    // Allow test files outside rootDir
                    rootDir: '.',
                },
            },
        ],
    },
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/test/**',
        '!src/__mocks__/**',
        '!src/extension.ts',
    ],
};
