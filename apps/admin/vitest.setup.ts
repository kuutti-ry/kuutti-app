import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect } from "vitest";

// The host's CSP allows styles from the panel's own stylesheet only (style-src
// 'self', ADR-025 §3): a component that writes a <style> element at run time,
// as Radix's dialog and Mantine's provider do, is refused there. Every test
// watches the document for one (ADR-050). jsdom only: the node-environment
// tests (the build's, the tokens') have no document.
let watch: MutationObserver | undefined;
let written: string[] = [];

const collect = (records: MutationRecord[]) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeName === "STYLE") written.push(node.textContent ?? "");
    }
  }
};

beforeEach(() => {
  if (typeof document === "undefined") return;
  written = [];
  watch = new MutationObserver(collect);
  watch.observe(document, { childList: true, subtree: true });
});

afterEach(() => {
  if (!watch) return;
  collect(watch.takeRecords());
  watch.disconnect();
  watch = undefined;
  expect(written, "a <style> element was written at run time, which the CSP refuses").toEqual([]);
});
