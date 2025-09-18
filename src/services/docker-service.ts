import {createSpinner} from 'nanospinner'
import {exec} from 'node:child_process'
import {MONOCF_FOLDER} from '../types/config-types.js'

export class DockerService {
  async start(): Promise<void> {
    const spinner = createSpinner('starting docker container...').start()

    // check docker container is running
    exec(`docker-compose ps`, {cwd: MONOCF_FOLDER}, (error, stdout) => {
      if (error) {
        spinner.error(`Failed to check docker container: ${error.message}`)
        return
      }

      if (stdout.includes('Up')) {
        exec('docker-compose down', {cwd: MONOCF_FOLDER}, (error) => {
          if (error) {
            spinner.error(`Failed to stop docker container: ${error.message}`)
            return
          }

          spinner.success('docker container stopped successfully.')
        })
      }
    })

    // start docker container
    exec(`docker-compose up --build -d`, {cwd: MONOCF_FOLDER}, (error) => {
      if (error) {
        spinner.error(`Failed to start docker container: ${error.message}`)
        return
      }

      spinner.success('docker container started successfully.')
    })
  }

  async stop(): Promise<void> {
    const spinner = createSpinner('stopping docker container...').start()
    exec(`docker-compose down`, {cwd: MONOCF_FOLDER}, (error) => {
      if (error) {
        spinner.error(`Failed to stop docker container: ${error.message}`)
        return
      }

      spinner.success('docker container stopped successfully.')
    })
  }
}
