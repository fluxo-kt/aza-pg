import { expect, test } from "bun:test";
import { formatDockerSize, formatSize } from "./logger";

test("formatSize uses 1024-based KB/MB/GB and switches unit where the printed value reaches 1024", () => {
  expect(formatSize(1536)).toBe("1.50 KB");
  expect(formatSize(1024 ** 2 - 1)).toBe("1.00 MB");
  expect(formatSize(1024 ** 2 - 6000)).toBe("1018.14 KB");
  expect(formatSize(5 * 1024 ** 3)).toBe("5.00 GB");
  expect(formatSize(3 * 1024 ** 4)).toBe("3072.00 GB");
});

test("formatDockerSize matches docker images: decimal units, three significant digits", () => {
  // Sizes docker images printed for v18.6-202610312251 (amd64, arm64).
  expect(formatDockerSize(416403947)).toBe("416MB");
  expect(formatDockerSize(432984691)).toBe("433MB");
  expect(formatDockerSize(1_234_567_890)).toBe("1.23GB");
  expect(formatDockerSize(512)).toBe("512B");
});
