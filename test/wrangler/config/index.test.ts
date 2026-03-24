import {expect} from 'chai'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {experimental_readRawConfig} from 'wrangler'

import {ConfigurationService} from '../../../src/services/configuration-service.js'
import {ErrorService} from '../../../src/services/error-service.js'
import {FileService} from '../../../src/services/file-service.js'
import {MONOCF_CONFIG_FILE} from '../../../src/types/config-types.js'
import {WRANGLER_FILE} from '../../../src/types/wrangler-types.js'

function createTempProject() {
  const root = mkdtempSync(join(tmpdir(), 'monocf-config-test-'))
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

  describe('parseJSONC', () => {
    it('should parse JSONC', () => {
      const {rawConfig} = experimental_readRawConfig({
        config: 'test/wrangler.jsonc',
      })
      expect(rawConfig).to.be.an('object')
    })
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

      expect(config.rootDir).to.equal(project.root)
      expect(config.workersDirName).to.equal(project.workersDirName)
      expect(config.workerName).to.equal(project.workerName)
      expect(fileService.getWorkers(config.rootDir, config.workersDirName)).to.deep.equal([project.workerName])
    })
  })
})
