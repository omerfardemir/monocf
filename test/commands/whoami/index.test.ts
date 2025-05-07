import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('whoami', () => {
  it('runs whoami command from wrangler', async () => {
    const {error} = await runCommand('whoami')
    expect(error).to.be.undefined
  })
})
