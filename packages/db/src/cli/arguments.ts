/** Maintenance commands never silently turn a misspelled dry run into a write (#380). */
export function argumentsOf(argv: readonly string[], allowed: readonly string[]) {
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at] as string;
    if (at === 0 && word === "--") continue;
    if (!word.startsWith("-")) {
      positionals.push(word);
      continue;
    }
    const equals = word.indexOf("=");
    const flag = equals < 0 ? word : word.slice(0, equals);
    if (!allowed.includes(flag)) throw new Error(`unknown argument ${flag}`);
    if (Object.hasOwn(options, flag)) throw new Error(`${flag} is given twice`);
    const value = equals < 0 ? argv[++at] : word.slice(equals + 1);
    if (!value || value.startsWith("-")) throw new Error(`${flag} takes a value`);
    options[flag] = value;
  }
  return { options, positionals };
}
