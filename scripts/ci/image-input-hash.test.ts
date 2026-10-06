import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  archives,
  baseImage,
  copySources,
  imageKey,
  packagesState,
  readGitIndex,
  selectInputs,
  uncoveredSources,
} from "./image-input-hash";

const ROOT = join(import.meta.dir, "../..");
const dockerfile = await Bun.file(join(ROOT, "docker/postgres/Dockerfile")).text();
const index = await readGitIndex(ROOT);
const sources = copySources(dockerfile);
const inputs = selectInputs(index, sources);
const DATES = ["a main/binary-amd64/Packages"];

describe("image input key", () => {
  test("every COPY source of the generated Dockerfile is a tracked file or directory", () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(uncoveredSources(index, sources)).toEqual([]);
  });

  test("COPY --from is skipped; flags and the destination are not sources", () => {
    expect(
      copySources("COPY --from=builder /opt/x /\nCOPY --chmod=0755 a.sh b.sh /dst/\nADD ./c /c")
    ).toEqual(["a.sh", "b.sh", "c"]);
  });

  test("every source of a COPY continued over several lines counts, comment lines included", () => {
    expect(copySources("COPY a.sh \\\n  # first\n  b.sh \\\n  /dst/\n# x \\\nCOPY c /c")).toEqual([
      "a.sh",
      "b.sh",
      "c",
    ]);
  });

  test("editing a covered file changes the key; editing docs/ does not", () => {
    const base = imageKey(inputs, DATES);
    const covered = inputs.find(
      (e) => e.path === "docker/postgres/docker-auto-config-entrypoint.sh"
    )!;
    const editedCovered = index.map((e) => (e === covered ? { ...e, blob: "0".repeat(40) } : e));
    expect(imageKey(selectInputs(editedCovered, sources), DATES)).not.toBe(base);

    const doc = index.find((e) => e.path.startsWith("docs/"))!;
    const editedDoc = index.map((e) => (e === doc ? { ...e, blob: "0".repeat(40) } : e));
    expect(imageKey(selectInputs(editedDoc, sources), DATES)).toBe(base);
  });

  test("a changed apt package index changes the key", () => {
    expect(imageKey(inputs, ["b main/binary-amd64/Packages"])).not.toBe(imageKey(inputs, DATES));
  });

  test("archive state is the SHA256 of the image's components' Packages indexes only", () => {
    const inRelease = [
      "Date: Sun, 04 Oct 2026 19:53:35 UTC",
      "SHA256:",
      " aaa 100 main/binary-amd64/Packages",
      " bbb 100 main/binary-arm64/Packages",
      " ccc 100 contrib/binary-amd64/Packages",
      " ddd 100 main/binary-amd64/Packages.xz",
      "SHA512:",
      " eee 100 main/binary-amd64/Packages",
    ].join("\n");
    // The re-signing Date and other components or encodings do not count; the SHA512 block is not read.
    expect(packagesState(inRelease, ["main"])).toBe(
      "aaa main/binary-amd64/Packages,bbb main/binary-arm64/Packages"
    );
    expect(() => packagesState(inRelease, ["18"])).toThrow("18/binary-amd64/Packages");
  });

  test("archives follow the base image's Debian codename and PostgreSQL major", () => {
    const { codename, pgMajor } = baseImage(dockerfile);
    const list = archives(codename, pgMajor);
    expect(list.every((a) => a.url.includes(`/${codename}`))).toBe(true);
    expect(list.at(-1)!.components).toEqual(["main", pgMajor]);
  });
});
