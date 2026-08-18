import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { destination, responseText } from "./index.ts";

test("responseText collects only assistant text parts", () => {
  expect(responseText({
    role: "assistant",
    content: [
      { type: "text", text: "first" },
      { type: "toolCall", name: "write" },
      { type: "text", text: " second" },
    ],
  })).toBe("first second");
});

test("destination accepts explicit project-relative paths", () => {
  expect(destination("docs/design.md")).toBe("docs/design.md");
  expect(destination("put it in `notes/answer.md`")).toBe("notes/answer.md");
});

test("destination gives guidance a deterministic safe fallback", () => {
  expect(destination("release notes")).toBe(".pi/responses/release-notes.md");
  expect(destination("")).toMatch(/^\.pi\/responses\/response-\d+\.md$/);
});

test("exclusive file creation does not overwrite an existing response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-export-response-"));
  const path = join(dir, "answer.md");
  await writeFile(path, "original\n");

  let error: NodeJS.ErrnoException | undefined;
  try {
    await writeFile(path, "replacement\n", { flag: "wx" });
  } catch (caught) {
    error = caught as NodeJS.ErrnoException;
  }

  expect(error?.code).toBe("EEXIST");
  expect(await Bun.file(path).text()).toBe("original\n");
});

test("extension records assistant responses and handles safe write outcomes", async () => {
  const events: ((event: any) => void)[] = [];
  const commands = new Map<string, (args: string | undefined, ctx: any) => Promise<void>>();
  extension({
    on(_name: string, handler: (event: any) => void) { events.push(handler); },
    registerCommand(name: string, definition: any) { commands.set(name, definition.handler); },
  } as any);
  const notify = (messages: string[]) => ({
    waitForIdle: async () => {},
    ui: { notify: (message: string) => messages.push(message) },
  });
  const write = commands.get("write-response")!;
  const messages: string[] = [];
  await write(undefined, notify(messages));
  expect(messages).toEqual(["There is no assistant response to write."]);

  events[0]({ message: { role: "user", content: [{ type: "text", text: "not a response" }] } });
  events[0]({ message: { role: "assistant", content: [{ type: "text", text: "draft" }] } });
  const dir = await mkdtemp(join(tmpdir(), "pi-export-response-extension-"));
  await write("nested/answer.md", { ...notify(messages), cwd: dir });
  expect(await readFile(join(dir, "nested/answer.md"), "utf8")).toBe("draft\n");
  expect(messages.at(-1)).toBe("Wrote last response to nested/answer.md");

  events[0]({ message: { role: "assistant", content: [{ type: "text", text: "draft\n" }] } });
  await write("nested/with-newline.md", { ...notify(messages), cwd: dir });
  expect(await readFile(join(dir, "nested/with-newline.md"), "utf8")).toBe("draft\n");

  await write("../outside.md", { ...notify(messages), cwd: dir });
  expect(messages.at(-1)).toBe("Refusing to write outside the current project.");
  await write("nested/answer.md", { ...notify(messages), cwd: dir });
  expect(messages.at(-1)).toBe("Refusing to overwrite existing file: nested/answer.md");
});
