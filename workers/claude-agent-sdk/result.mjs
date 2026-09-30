// Claude's hook returns either plain text or the MCP content envelope, depending on whether
// structuredContent was present. Both encodings must preserve ESCALATED as a non-error result.
export function normalizeToolResult(response) {
  if (typeof response === "string") return { isError: false, text: response };
  const content = Array.isArray(response) ? response : response?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((item) => item?.type === "text").map((item) => item.text).join("\n")
    : JSON.stringify(response);
  return { isError: Boolean(response?.isError), structured: response?.structuredContent, text };
}
