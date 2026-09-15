/** Remove C0/C1 controls so local collector data cannot emit terminal commands. */
export function sanitizeTerminal(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}
