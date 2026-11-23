import { jest } from "@jest/globals";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { authEnv, git, parseRawDiff, readBlob } from "../src/git.js";

describe("parseRawDiff", () => {
  it("parses an empty output", () => {
    expect(parseRawDiff("")).toEqual([]);
  });

  it("parses changes", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const z = "0".repeat(40);
    const output = [
      `:100644 100644 ${a} ${b} M`,
      "update me.txt",
      `:000000 100644 ${z} ${b} A`,
      '"new"\nfile.txt',
      `:100644 000000 ${a} ${z} D`,
      "dir/delete-me.txt",
      "",
    ].join("\0");
    expect(parseRawDiff(output)).toEqual([
      {
        path: "update me.txt",
        oldMode: "100644",
        newMode: "100644",
        newSha: b,
        status: "M",
      },
      {
        path: '"new"\nfile.txt',
        oldMode: "000000",
        newMode: "100644",
        newSha: b,
        status: "A",
      },
      {
        path: "dir/delete-me.txt",
        oldMode: "100644",
        newMode: "000000",
        newSha: z,
        status: "D",
      },
    ]);
  });

  it("throws on unexpected output", () => {
    expect(() => parseRawDiff("foo\0bar\0")).toThrow(/unexpected output/);
  });
});

describe("authEnv", () => {
  it("resets existing extra headers and adds the token", () => {
    expect(authEnv("https://github.com/", "secret")).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from("x-access-token:secret").toString("base64")}`,
    });
  });
});

describe("git", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "actions-commit-"));
    await git(["init", "--quiet"], dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps binary output as is", async () => {
    // invalid as UTF-8
    const contents = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0xc3]);
    await fs.writeFile(path.join(dir, "binary"), contents);
    const sha = (await git(["hash-object", "-w", "binary"], dir))
      .toString()
      .trim();
    expect(await readBlob(sha, dir)).toEqual(contents);
  });

  it("reads a blob from a subdirectory, and removes the temporary file", async () => {
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "file"), "contents\n");
    const sha = (await git(["hash-object", "-w", "sub/file"], dir))
      .toString()
      .trim();

    const contents = await readBlob(sha, path.join(dir, "sub"));

    expect(contents.toString()).toBe("contents\n");
    // no temporary files are left in the working tree.
    const status = await git(
      ["status", "--porcelain", "--untracked-files=all"],
      dir,
    );
    expect(status.toString()).toBe("?? sub/file\n");
  });

  it("reads a large blob without line separators", async () => {
    const contents = Buffer.alloc(32 * 1024 * 1024, "a");
    await fs.writeFile(path.join(dir, "large"), contents);
    const sha = (await git(["hash-object", "-w", "large"], dir))
      .toString()
      .trim();
    expect((await readBlob(sha, dir)).equals(contents)).toBe(true);
  });

  it("passes additional environment variables", async () => {
    const output = await git(["config", "--get", "foo.bar"], dir, {
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "foo.bar",
        GIT_CONFIG_VALUE_0: "baz",
      },
    });
    expect(output.toString().trim()).toBe("baz");
  });

  it("throws an error with stderr on failure", async () => {
    await expect(git(["rev-parse", "no-such-ref"], dir)).rejects.toThrow(
      /git rev-parse no-such-ref failed with exit code 128: .*no-such-ref/s,
    );
  });

  describe("debug log", () => {
    let written: string[];

    beforeEach(() => {
      written = [];
      jest
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          written.push(chunk.toString());
          return true;
        });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const debugLog = () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("::debug::"))
        .map((line) => line.slice("::debug::".length));

    it("writes the command and its outputs to the debug log", async () => {
      await git(["config", "--get", "foo.bar"], dir, {
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "foo.bar",
          GIT_CONFIG_VALUE_0: "baz",
        },
      }).catch(() => {});
      await expect(git(["rev-parse", "no such ref"], dir)).rejects.toThrow();

      const log = debugLog();
      expect(log).toContain(`[command] git config --get foo.bar (cwd: ${dir})`);
      expect(log).toContain("[exit code] 0");
      expect(log).toContain("[stdout] baz");
      expect(log).toContain(
        `[command] git rev-parse "no such ref" (cwd: ${dir})`,
      );
      expect(log).toContain("[exit code] 128");
      expect(log.some((line) => line.startsWith("[stderr] fatal:"))).toBe(true);
      // environment variables are never logged.
      expect(log.some((line) => line.includes("GIT_CONFIG"))).toBe(false);
    });

    it("doesn't write contents of files", async () => {
      await fs.writeFile(path.join(dir, "file"), "file contents\n");
      const sha = (await git(["hash-object", "-w", "file"], dir))
        .toString()
        .trim();
      written = [];

      expect((await readBlob(sha, dir)).toString()).toBe("file contents\n");

      const log = debugLog();
      expect(log).toContain(`[command] git unpack-file ${sha} (cwd: ${dir})`);
      expect(log.some((line) => line.includes("file contents"))).toBe(false);
    });
  });
});
