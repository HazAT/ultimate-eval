import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recipes } from '../recipes.js'

test('every recipe has an id, a name and a cooking time', () => {
  for (const recipe of recipes) {
    assert.match(recipe.id, /^[a-z0-9-]+$/)
    assert.ok(recipe.name)
    assert.ok(recipe.minutes > 0)
  }
  assert.equal(new Set(recipes.map((r) => r.id)).size, recipes.length)
})
