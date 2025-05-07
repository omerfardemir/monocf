import {appendFile, existsSync, readFileSync, writeFileSync} from 'node:fs'

/**
 * Appends a line to a file
 * @param filePath Path to the file
 * @param line Line to append
 * @param checkLineExists If true, checks if the line already exists in the file
 */
export function appendLine(filePath: string, line: string, checkLineExists?: boolean): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, line)
    return
  }

  if (checkLineExists) {
    const fileContent = readFileSync(filePath, 'utf8')
    if (fileContent.includes(line)) return
  }

  appendFile(filePath, '\n' + line, (err) => {
    if (err) throw err
  })
}
