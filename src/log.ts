export type Logger = (line: string) => void

/** stdout belongs to the MCP transport; everything else goes to stderr. */
export const stderrLogger: Logger = (line) => {
  process.stderr.write(`leap: ${line}\n`)
}

export const silentLogger: Logger = () => {}
