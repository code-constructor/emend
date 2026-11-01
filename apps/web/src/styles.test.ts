// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const webSource = fileURLToPath(new URL(".", import.meta.url));
const webLicenses = fileURLToPath(new URL("../public/licenses/", import.meta.url));
const webFonts = join(webSource, "fonts");
const fontFiles = [
  "hanken-grotesk-latin-wght-normal.woff2",
  "hanken-grotesk-latin-ext-wght-normal.woff2",
  "hanken-grotesk-latin-wght-italic.woff2",
  "martian-mono-latin-standard-normal.woff2",
  "martian-mono-latin-ext-standard-normal.woff2",
];
const fontLicenses = ["hanken-grotesk-OFL.txt", "martian-mono-OFL.txt"];

function webStylesheets() {
  return readdirSync(webSource, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".css"))
    .map((path) => ({
      path: join(webSource, path),
      css: readFileSync(join(webSource, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
    }));
}

function cssUrls(css: string) {
  const matches = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)];
  expect(matches).toHaveLength([...css.matchAll(/url\(/gi)].length);
  return matches.map((match) => match[2]?.trim() ?? "");
}

test("web CSS loads only relative bundled fonts and never imports a remote stylesheet", () => {
  const stylesheets = webStylesheets();
  expect(stylesheets.length).toBeGreaterThan(0);
  for (const { path, css } of stylesheets) {
    for (const url of cssUrls(css)) {
      expect(url, path).toMatch(/^\.{1,2}\//);
      const asset = resolve(dirname(path), url);
      expect(dirname(asset), path).toBe(webFonts);
      expect(statSync(asset).isFile(), url).toBe(true);
    }
    const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?(["'])(.*?)\1/gi)];
    expect(imports).toHaveLength([...css.matchAll(/@import\b/gi)].length);
    for (const match of imports) {
      expect(match[2]?.trim(), path).not.toMatch(/^(?:[a-z][\w+.-]*:|\/\/)/i);
    }
  }
});

test("the five variable fonts and their OFL licences ship with matching font-face sources", () => {
  for (const file of fontFiles) {
    const bytes = readFileSync(join(webFonts, file));
    expect(bytes.subarray(0, 4).toString(), file).toBe("wOF2");
  }
  for (const file of fontLicenses) {
    expect(readFileSync(join(webLicenses, file), "utf8"), file).toContain("SIL OPEN FONT LICENSE Version 1.1");
  }
  const sources: string[] = [];
  for (const { path, css } of webStylesheets()) {
    for (const face of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
      const declarations = face[1] ?? "";
      const src = /\bsrc\s*:\s*([^;]+);/i.exec(declarations)?.[1] ?? "";
      const urls = cssUrls(src);
      expect(urls).toHaveLength(1);
      expect(declarations).toMatch(/font-display:\s*swap\s*;/);
      for (const url of urls) {
        const martian = url.includes("martian-mono-");
        const italic = url.endsWith("-italic.woff2");
        expect(declarations, url).toMatch(martian ? /font-weight:\s*100\s+800\s*;/ : /font-weight:\s*100\s+900\s*;/);
        if (martian) expect(declarations, url).toMatch(/font-stretch:\s*75%\s+112\.5%\s*;/);
        expect(declarations, url).toMatch(italic ? /font-style:\s*italic\s*;/ : /font-style:\s*normal\s*;/);
        if (!italic) expect(declarations, url).toMatch(/unicode-range:\s*U\+[0-9a-f]/i);
        sources.push(resolve(dirname(path), url));
      }
    }
  }
  expect(sources.sort()).toEqual(fontFiles.map((file) => join(webFonts, file)).sort());
});

test("reading components use semantic colours, with white reserved for the isolated HTML document page", () => {
  const reading = join(webSource, "components/reading");
  for (const file of readdirSync(reading).filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))) {
    const source = readFileSync(join(reading, file), "utf8");
    expect(source, file).not.toMatch(/(?:neutral-|amber-|dark:|bg-white|text-white)/);
    if (source.includes("bg-[#fff]")) expect(file).toBe("HtmlDocFrame.tsx");
  }
  const frame = readFileSync(join(webSource, "../mermaid-frame.html"), "utf8");
  expect(frame).toMatch(/:root\s*\{\s*color-scheme:\s*light dark/);
  expect(frame).toMatch(/body\s*\{\s*background:\s*transparent/);
});
