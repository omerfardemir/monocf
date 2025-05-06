import { expect } from "chai";
import { experimental_readRawConfig } from 'wrangler';

describe(
  'parseJSONC',
  () => {
    it('should parse JSONC', () => {
      const { rawConfig } = experimental_readRawConfig({
        config: 'test/wrangler.jsonc'
      });
      expect(rawConfig).to.be.an('object');
    });
  }
)