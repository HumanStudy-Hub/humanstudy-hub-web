export function downloadTextReport(filename: string, title: string, sections: Array<[string, string]>) {
  const content = [title, "=".repeat(title.length), "", ...sections.flatMap(([heading, body]) => [heading, "-".repeat(heading.length), body || "Not available", ""])].join("\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  link.click();
  URL.revokeObjectURL(url);
}
