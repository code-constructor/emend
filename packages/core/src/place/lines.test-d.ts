import type { FileSides } from "./lines.ts";

// A hash never proves that the side's text was available for readback.
// @ts-expect-error An existing old side requires its text.
export const oldHashOnly: FileSides = { oldHash: "a" };
// @ts-expect-error An existing new side requires its text.
export const newHashOnly: FileSides = { newHash: "a" };
export const deletedSides: FileSides = {};
export const emptySide: FileSides = { newText: "", newHash: "a" };
