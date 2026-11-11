// The command lines' shared refusals: one `✖` line and exit 1.

export function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

/** An empty value is no value (#235): each command says above its call what one would break. */
export function refuseEmptyValues(values: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === "") fail(`--${name} takes a value`);
  }
}
