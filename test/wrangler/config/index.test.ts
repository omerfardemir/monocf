import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {ConfigurationService} from '../../../src/services/configuration-service.js'
import {ErrorService} from '../../../src/services/error-service.js'
import {FileService} from '../../../src/services/file-service.js'
import {MONOCF_CONFIG_FILE} from '../../../src/types/config-types.js'
import {WRANGLER_FILE} from '../../../src/types/wrangler-types.js'

function createTempProject() {
  // The CLI compares against process.cwd(), which reports the resolved path (macOS and CI temp dirs can be symlinks).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monocf-config-test-')))
  const workersDirName = 'workers'
  const workerName = 'my-worker'
  const workerDir = join(root, workersDirName, workerName)

  mkdirSync(workerDir, {recursive: true})
  writeFileSync(
    join(root, MONOCF_CONFIG_FILE),
    JSON.stringify(
      {
        rootDir: './',
        workersDirName,
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(join(workerDir, WRANGLER_FILE), JSON.stringify({name: workerName}, null, 2), 'utf8')

  return {root, workerDir, workerName, workersDirName}
}

describe('wrangler config', () => {
  const originalCwd = process.cwd()
  let tempRoot: string | undefined

  afterEach(() => {
    process.chdir(originalCwd)

    if (tempRoot) {
      rmSync(tempRoot, {recursive: true, force: true})
      tempRoot = undefined
    }
  })

  describe('ConfigurationService', () => {
    it('resolves a relative rootDir from the config file location and infers the worker name from cwd', () => {
      const project = createTempProject()
      tempRoot = project.root
      process.chdir(project.workerDir)

      const errorService = new ErrorService()
      const configurationService = new ConfigurationService(errorService)
      const fileService = new FileService(errorService)

      const config = configurationService.loadConfiguration(
        {
          command: 'build',
        },
        {},
      )

      expect(config.rootDir).toBe(project.root)
      expect(config.workersDirName).toBe(project.workersDirName)
      expect(config.workerName).toBe(project.workerName)
      expect(fileService.getWorkers(config.rootDir, config.workersDirName)).toEqual([project.workerName])
    })
  })
})
