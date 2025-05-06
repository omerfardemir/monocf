import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

export default [
  {
    ignores: ["**/dist", "**/build", "**/docs", "**/*.md", "**/templates", "**/examples"]
  },
  includeIgnoreFile(gitignorePath), 
  ...oclif, 
  prettier,
  {
    rules: {
      '@typescript-eslint/camelcase': 'off',
      'camelcase': 'off',
      'no-await-in-loop': 'off',
      'perfectionist/sort-array-includes': 'off',
      'perfectionist/sort-classes': 'off',
      'perfectionist/sort-decorators': 'off',
      'perfectionist/sort-enums': 'off',
      'perfectionist/sort-exports': 'off',
      'perfectionist/sort-heritage-clauses': 'off',
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-interfaces': 'off',
      'perfectionist/sort-intersection-types': 'off',
      'perfectionist/sort-jsx-props': 'off',
      'perfectionist/sort-maps': 'off',
      'perfectionist/sort-modules': 'off',
      'perfectionist/sort-named-exports': 'off',
      'perfectionist/sort-named-imports': 'off',
      'perfectionist/sort-object-types': 'off',
      'perfectionist/sort-objects': 'off',
      'perfectionist/sort-sets': 'off',
      'perfectionist/sort-switch-case': 'off',
      'perfectionist/sort-union-types': 'off',
      'perfectionist/sort-variable-declarations': 'off'
    }
  }
]
