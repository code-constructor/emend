import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "./App.tsx";

afterEach(cleanup);

test("App renders the emend heading", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "emend", level: 1 })).toBeTruthy();
});
