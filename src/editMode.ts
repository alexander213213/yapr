import { useEffect } from "react";

/**
 * Global input-ownership registry. Ink broadcasts every keypress to ALL
 * mounted useInput hooks, so a TextInput being edited somewhere must be able
 * to stand down unrelated shortcut handlers (rename typing `s` must not open
 * Settings). Two counters:
 * - edit: a text field is being edited (letter shortcuts stand down; Tab
 *   keeps working so composer focus-cycling is unaffected).
 * - block: a modal owns the screen (all shortcut handlers stand down).
 * Checked per keypress, so no subscription machinery is needed. Cleanup on
 * unmount/effect teardown makes leaks impossible through the hooks.
 */
let editDepth = 0;
let blockDepth = 0;

export function beginEdit(): void {
  editDepth += 1;
}
export function endEdit(): void {
  editDepth = Math.max(0, editDepth - 1);
}
export function isEditingText(): boolean {
  return editDepth > 0;
}

export function useEditMode(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    beginEdit();
    return () => {
      endEdit();
    };
  }, [active]);
}

export function beginBlock(): void {
  blockDepth += 1;
}
export function endBlock(): void {
  blockDepth = Math.max(0, blockDepth - 1);
}
export function isBlocked(): boolean {
  return blockDepth > 0;
}

export function useBlockingModal(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    beginBlock();
    return () => {
      endBlock();
    };
  }, [active]);
}
