/**
 * Best-effort extraction of a JSON object from model output. Tries, in order:
 *   1. the whole string as JSON,
 *   2. a fenced ```json ... ``` block,
 *   3. the substring from the first '{' to the last '}'.
 * Returns null if nothing parses. Used by the evaluator before fail-closing —
 * some model surfaces wrap JSON output in prose/fences.
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* fall through */
    }
  }

  return null;
}
