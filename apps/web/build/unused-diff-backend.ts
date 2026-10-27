function disabled() {
  throw new Error("This diff backend is disabled. emend uses shiki-js.");
}

export {
  disabled as createOnigurumaEngine,
  disabled as HighlightsHighlighter,
  disabled as themes,
  disabled as default,
};

disabled();
