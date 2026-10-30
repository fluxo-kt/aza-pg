import { expect, test } from "bun:test";
import { formatSize } from "./logger";

test("formatSize uses 1024-based KB/MB/GB and switches unit where the printed value reaches 1024", () => {
  expect(formatSize(1536)).toBe("1.50 KB");
  expect(formatSize(1024 ** 2 - 1)).toBe("1.00 MB");
  expect(formatSize(1024 ** 2 - 6000)).toBe("1018.14 KB");
  expect(formatSize(5 * 1024 ** 3)).toBe("5.00 GB");
  expect(formatSize(3 * 1024 ** 4)).toBe("3072.00 GB");
});
