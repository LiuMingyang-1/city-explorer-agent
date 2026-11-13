import type { TestContext } from "node:test";
/** node:test after hooks run in registration order. Release nested resources first,
 * then delete their temporary directory (Windows forbids deleting open SQLite files).
 */
const stacks = new WeakMap<TestContext, (() => unknown | Promise<unknown>)[]>();
export function afterResource(t: TestContext, release: () => unknown | Promise<unknown>): void {
  let stack = stacks.get(t);
  if (!stack) {
    stack = []; stacks.set(t, stack);
    t.after(async () => {
      const failures: unknown[] = [];
      for (const dispose of stack!.reverse()) {
        try { await dispose(); } catch (e) { failures.push(e); }
      }
      if (failures.length) throw new AggregateError(failures, "Resource cleanup failed");
    });
  }
  stack.push(release);
}
