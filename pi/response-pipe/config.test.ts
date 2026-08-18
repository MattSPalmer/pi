import { test, expect } from "bun:test";
import {
  DEFAULT_PIPE_CONFIG,
  parsePipeInvocation,
  readPipeConfig,
} from "./config.ts";

test("pipe configuration has safe defaults", () => {
  expect(readPipeConfig({})).toEqual(DEFAULT_PIPE_CONFIG);
});

test("pipe configuration reads shell, limits, retries, and confirmation", () => {
  expect(readPipeConfig({
    PI_RESPONSE_PIPE_SHELL: " /bin/bash ",
    PI_RESPONSE_PIPE_TIMEOUT_MS: "1250.9",
    PI_RESPONSE_PIPE_MAX_STDOUT_BYTES: "2048",
    PI_RESPONSE_PIPE_MAX_STDERR_BYTES: "512",
    PI_RESPONSE_PIPE_MAX_REPAIR_ATTEMPTS: "3.9",
    PI_RESPONSE_PIPE_CONFIRM: "off",
  })).toEqual({
    shell: "/bin/bash",
    timeoutMs: 1250,
    maxStdoutBytes: 2048,
    maxStderrBytes: 512,
    maxRepairAttempts: 3,
    confirm: false,
    permissions: true,
  });
  expect(readPipeConfig({ PI_RESPONSE_PIPE_NO_CONFIRM: "NO" }).confirm).toBe(false);
});

test("invalid configuration values fall back and retries may be zero", () => {
  expect(readPipeConfig({
    PI_RESPONSE_PIPE_SHELL: "   ",
    PI_RESPONSE_PIPE_TIMEOUT_MS: "-1",
    PI_RESPONSE_PIPE_MAX_STDOUT_BYTES: "nan",
    PI_RESPONSE_PIPE_MAX_STDERR_BYTES: "Infinity",
    PI_RESPONSE_PIPE_MAX_REPAIR_ATTEMPTS: "0",
  })).toEqual({
    ...DEFAULT_PIPE_CONFIG,
    maxRepairAttempts: 0,
  });
  expect(readPipeConfig({ PI_RESPONSE_PIPE_PERMISSIONS: "no" }).permissions).toBe(false);
});

test("pipe invocation recognizes only explicit leading confirmation switches", () => {
  expect(parsePipeInvocation("--yes extract names")).toEqual({
    request: "extract names",
    skipConfirmation: true,
  });
  expect(parsePipeInvocation("-y --no-confirm -- extract names")).toEqual({
    request: "extract names",
    skipConfirmation: true,
  });
  expect(parsePipeInvocation("--yes")).toEqual({ request: "", skipConfirmation: true });
  expect(parsePipeInvocation("--verbose extract names")).toEqual({
    request: "--verbose extract names",
    skipConfirmation: false,
  });
  expect(parsePipeInvocation(undefined)).toEqual({ request: "", skipConfirmation: false });
});
